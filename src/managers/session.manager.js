const logger = require('../core/logger').createServiceLogger('SESSION');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

class SessionManager {
  constructor() {
    this.sessionMemory = [];
    this.compressionEnabled = true;
    this.maxSize = config.get('session.maxMemorySize');
    this.compressionThreshold = config.get('session.compressionThreshold');
    this.currentSkill = 'dsa'; // Safe default; initialization chooses an available fallback if needed.
    this.skillPrompts = new Map();
    this.isInitialized = false;

    this.initializeWithSkillPrompts();
  }

  /**
   * Initialize session memory with all available skill prompts.
   */
  async initializeWithSkillPrompts() {
    if (this.isInitialized) return true;

    try {
      // Discover prompt files before creating the session's skill context.
      promptLoader.loadPrompts();

      const availableSkills = promptLoader.getAvailableSkills()
        .map(skill => typeof skill === 'string' ? skill.trim().toLowerCase() : '')
        .filter(Boolean);

      this.skillPrompts.clear();

      if (availableSkills.length === 0) {
        logger.warn('No skill prompts were discovered during session initialization');
        this.isInitialized = true;
        return true;
      }

      // Keep the active skill valid even when the prompt directory does not
      // contain the default DSA prompt.
      const rawCurrentSkill = typeof this.currentSkill === 'string'
        ? this.currentSkill.trim().toLowerCase()
        : '';

      const normalizedCurrentSkill = promptLoader.normalizeSkillName(this.currentSkill);

      if (availableSkills.includes(rawCurrentSkill)) {
        this.currentSkill = rawCurrentSkill;
      } else if (availableSkills.includes(normalizedCurrentSkill)) {
        this.currentSkill = normalizedCurrentSkill;
      } else {
        this.currentSkill = availableSkills.includes('dsa')
          ? 'dsa'
          : availableSkills[0];
      }

      // Cache each discovered prompt and retain initialization events for
      // compatibility with existing session-history behaviour.
      for (const skill of availableSkills) {
        const skillPrompt = promptLoader.getSkillPrompt(skill);

        if (typeof skillPrompt !== 'string' || !skillPrompt.trim()) {
          logger.warn('Skipping an empty or unavailable skill prompt', { skill });
          continue;
        }

        this.skillPrompts.set(skill, skillPrompt);

        const event = this.createConversationEvent({
          role: 'system',
          content: skillPrompt,
          skill,
          action: 'skill_prompt_initialization',
          metadata: {
            isInitialization: true,
            skillName: skill
          }
        });

        this.sessionMemory.push(event);
      }

      this.isInitialized = true;

      logger.info('Session memory initialized with skill prompts', {
        skillCount: this.skillPrompts.size,
        activeSkill: this.currentSkill,
        totalEvents: this.sessionMemory.length
      });

      return true;

    } catch (error) {
      this.isInitialized = false;

      logger.error('Failed to initialize session memory with skill prompts', {
        error: error.message
      });

      return false;
    }
  }

  /**
   * Set the current active skill.
   * Returns true when activation succeeds and false otherwise.
   */
  setActiveSkill(skill) {
    const rawSkill = typeof skill === 'string'
      ? skill.trim().toLowerCase()
      : '';

    const normalizedSkill = promptLoader.normalizeSkillName(skill);

    const availableSkills = promptLoader.getAvailableSkills()
      .map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
      .filter(Boolean);

    // Prefer an exact prompt filename match, then allow PromptLoader aliases.
    const activeSkill = availableSkills.includes(rawSkill)
      ? rawSkill
      : normalizedSkill;

    if (!activeSkill || !availableSkills.includes(activeSkill)) {
      logger.warn('Rejected unknown skill in SessionManager.setActiveSkill', {
        requestedSkill: skill,
        normalizedSkill: activeSkill,
        availableSkills
      });

      return false;
    }

    const skillPrompt = promptLoader.getSkillPrompt(activeSkill);

    if (typeof skillPrompt !== 'string' || !skillPrompt.trim()) {
      logger.warn('Rejected skill because its prompt could not be loaded', {
        skill: activeSkill
      });

      return false;
    }

    const previousSkill = this.currentSkill;

    // Keep the prompt cache current in case prompts were reloaded after startup.
    this.skillPrompts.set(activeSkill, skillPrompt);

    if (previousSkill === activeSkill) {
      return true;
    }

    this.currentSkill = activeSkill;

    this.addConversationEvent({
      role: 'system',
      content: `Switched to ${activeSkill} mode`,
      action: 'skill_change',
      metadata: {
        previousSkill,
        newSkill: activeSkill
      }
    });

    logger.info('Active skill changed', {
      from: previousSkill,
      to: activeSkill
    });

    return true;
  }

  /**
   * Add a conversation event with proper role classification.
   */
  addConversationEvent({ role, content, action = null, metadata = {} }) {
    const event = this.createConversationEvent({
      role,
      content,
      skill: this.currentSkill,
      action: action || this.inferActionFromRole(role),
      metadata
    });

    this.sessionMemory.push(event);

    logger.debug('Conversation event added', {
      role,
      action: event.action,
      skill: this.currentSkill,
      contentLength: content?.length || 0,
      totalEvents: this.sessionMemory.length
    });

    this.performMaintenanceIfNeeded();

    return event.id;
  }

  /**
   * Add user transcription or chat input.
   */
  addUserInput(text, source = 'chat') {
    return this.addConversationEvent({
      role: 'user',
      content: text,
      action: source === 'speech' ? 'speech_transcription' : 'chat_input',
      metadata: {
        source,
        textLength: text.length
      }
    });
  }

  /**
   * Add LLM/model response.
   */
  addModelResponse(text, metadata = {}) {
    return this.addConversationEvent({
      role: 'model',
      content: text,
      action: 'llm_response',
      metadata: {
        ...metadata,
        responseLength: text.length
      }
    });
  }

  /**
   * Add OCR extracted text.
   */
  addOCREvent(extractedText, metadata = {}) {
    return this.addConversationEvent({
      role: 'user',
      content: extractedText,
      action: 'ocr_extraction',
      metadata: {
        ...metadata,
        source: 'screenshot',
        textLength: extractedText.length
      }
    });
  }

  /**
   * Create a conversation event with consistent structure.
   */
  createConversationEvent({ role, content, skill, action, metadata = {} }) {
    return {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      role: role,
      content,
      skill: skill || this.currentSkill,
      action,
      category: this.categorizeAction(action),
      metadata: {
        ...metadata,
        contentLength: content?.length || 0
      },
      contextSummary: this.generateContextSummary(action, {
        role,
        content,
        skill: skill || this.currentSkill,
        ...metadata
      })
    };
  }

  /**
   * Infer action from role.
   */
  inferActionFromRole(role) {
    switch (role) {
      case 'user':
        return 'user_message';

      case 'model':
        return 'model_response';

      case 'system':
        return 'system_message';

      default:
        return 'unknown';
    }
  }

  /**
   * Get conversation history for LLM context.
   */
  getConversationHistory(maxEntries = 20) {
    // Get recent conversation events (excluding system initialization).
    const conversationEvents = this.sessionMemory
      .filter(event => event.role !== 'system' || !event.metadata?.isInitialization)
      .slice(-maxEntries);

    return conversationEvents.map(event => ({
      role: event.role,
      content: event.content,
      timestamp: event.timestamp,
      skill: event.skill,
      action: event.action
    }));
  }

  /**
   * Get the entire conversation history (excluding initialization system messages).
   * This is useful when the model needs complete context for each new message.
   */
  getFullConversationHistory() {
    const conversationEvents = this.sessionMemory
      .filter(event => event.role !== 'system' || !event.metadata?.isInitialization);

    return conversationEvents.map(event => ({
      role: event.role,
      content: event.content,
      timestamp: event.timestamp,
      skill: event.skill,
      action: event.action
    }));
  }

  /**
   * Get skill-specific context with optional programming language support.
   *
   * @param {string|null} skillName - Target skill name (defaults to current skill).
   * @param {string|null} programmingLanguage - Optional programming language for injection.
   */
  getSkillContext(skillName = null, programmingLanguage = null) {
    const requestedSkill = skillName || this.currentSkill;

    const rawSkill = typeof requestedSkill === 'string'
      ? requestedSkill.trim().toLowerCase()
      : '';

    const normalizedSkill = promptLoader.normalizeSkillName(requestedSkill);

    const availableSkills = promptLoader.getAvailableSkills()
      .map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
      .filter(Boolean);

    // Prefer an exact prompt filename match, then allow PromptLoader aliases.
    const resolvedSkill = availableSkills.includes(rawSkill)
      ? rawSkill
      : normalizedSkill;

    // Never build an LLM context for a skill that is not backed by a prompt.
    const targetSkill = resolvedSkill && availableSkills.includes(resolvedSkill)
      ? resolvedSkill
      : this.currentSkill;

    if (targetSkill !== resolvedSkill) {
      logger.warn('Requested skill context was unavailable; using the active skill', {
        requestedSkill,
        activeSkill: this.currentSkill
      });
    }

    const requiresProgrammingLanguage =
      promptLoader.requiresProgrammingLanguage(targetSkill);

    // Read from PromptLoader for each context request so prompt updates and
    // language-specific injection are reflected immediately.
    let skillPrompt = null;

    if (programmingLanguage && requiresProgrammingLanguage) {
      skillPrompt = promptLoader.getSkillPrompt(targetSkill, programmingLanguage);
    } else {
      skillPrompt = promptLoader.getSkillPrompt(targetSkill);
    }

    // Fall back to the startup cache, then to the initialization event.
    if (typeof skillPrompt !== 'string' || !skillPrompt.trim()) {
      skillPrompt = this.skillPrompts.get(targetSkill) || null;
    }

    if (!skillPrompt) {
      const skillPromptEvent = this.sessionMemory.find(event =>
        event.action === 'skill_prompt_initialization' &&
        event.skill === targetSkill
      );

      skillPrompt = skillPromptEvent?.content || null;
    }

    if (skillPrompt) {
      this.skillPrompts.set(targetSkill, skillPrompt);
    }

    // Get recent events for this skill only.
    const skillEvents = this.sessionMemory
      .filter(event =>
        event.skill === targetSkill &&
        !event.metadata?.isInitialization
      )
      .slice(-10);

    return {
      skillPrompt,
      recentEvents: skillEvents,
      currentSkill: targetSkill,
      programmingLanguage,
      requiresProgrammingLanguage
    };
  }

  addEvent(action, details = {}) {
    const event = this.createEvent(action, details);
    this.sessionMemory.push(event);

    logger.debug('Session event added', {
      action,
      eventId: event.id,
      totalEvents: this.sessionMemory.length
    });

    this.performMaintenanceIfNeeded();

    return event.id;
  }

  createEvent(action, details) {
    return {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      action,
      category: this.categorizeAction(action),
      primaryContent: this.extractPrimaryContent(action, details),
      metadata: this.extractMetadata(action, details),
      contextSummary: this.generateContextSummary(action, details)
    };
  }

  generateEventId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  categorizeAction(action) {
    const actionLower = (action || '').toLowerCase();

    if (actionLower.includes('screenshot') || actionLower.includes('ocr')) {
      return 'capture';
    }

    if (actionLower.includes('speech') || actionLower.includes('transcription')) {
      return 'speech';
    }

    if (actionLower.includes('llm') || actionLower.includes('gemini')) {
      return 'llm';
    }

    if (actionLower.includes('skill') || actionLower.includes('switch')) {
      return 'navigation';
    }

    return 'system';
  }

  extractPrimaryContent(action, details) {
    if (details.text && typeof details.text === 'string') {
      return details.text.substring(0, 200);
    }

    if (details.response && typeof details.response === 'string') {
      return details.response.substring(0, 200);
    }

    if (details.preview && typeof details.preview === 'string') {
      return details.preview;
    }

    return null;
  }

  extractMetadata(action, details) {
    const metadata = {};

    const metadataFields = [
      'skill',
      'duration',
      'size',
      'textLength',
      'processingTime'
    ];

    metadataFields.forEach(field => {
      if (details[field] !== undefined) {
        metadata[field] = details[field];
      }
    });

    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  generateContextSummary(action, details) {
    const role = details.role;
    const skill = details.skill || this.currentSkill;

    switch (action) {
      case 'speech_transcription':
        return `User spoke: "${details.content?.substring(0, 50)}..." (${skill} mode)`;

      case 'chat_input':
        return `User typed: "${details.content?.substring(0, 50)}..." (${skill} mode)`;

      case 'llm_response':
        return `AI responded in ${skill} mode (${details.responseLength || details.contentLength} chars)`;

      case 'ocr_extraction':
        return `Screenshot text extracted: ${details.textLength || details.contentLength} characters (${skill} mode)`;

      case 'skill_change':
        return `Switched from ${details.previousSkill} to ${details.newSkill} mode`;

      case 'skill_prompt_initialization':
        return `${skill} skill prompt loaded for context`;

      case 'user_message':
        return `User: "${details.content?.substring(0, 50)}..." (${skill})`;

      case 'model_response':
        return `Model: Response in ${skill} mode (${details.contentLength} chars)`;

      default:
        if (role === 'user') {
          return `User input in ${skill} mode`;
        } else if (role === 'model') {
          return `Model response in ${skill} mode`;
        }

        return action || 'Unknown action';
    }
  }

  performMaintenanceIfNeeded() {
    if (this.sessionMemory.length > this.maxSize) {
      this.performMaintenance();
    } else if (
      this.compressionEnabled &&
      this.sessionMemory.length > this.compressionThreshold
    ) {
      this.compressOldEvents();
    }
  }

  performMaintenance() {
    const beforeCount = this.sessionMemory.length;

    this.removeOldSystemEvents();
    this.consolidateSimilarEvents();

    const afterCount = this.sessionMemory.length;

    logger.info('Session memory maintenance completed', {
      beforeCount,
      afterCount,
      eventsRemoved: beforeCount - afterCount
    });
  }

  removeOldSystemEvents() {
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000);

    this.sessionMemory = this.sessionMemory.filter(event => {
      const eventTime = new Date(event.timestamp).getTime();
      const shouldKeep = event.category !== 'system' || eventTime > cutoffTime;

      return shouldKeep;
    });
  }

  consolidateSimilarEvents() {
    const groups = this.groupSimilarEvents();
    const consolidated = [];

    for (const group of groups) {
      if (group.length === 1) {
        consolidated.push(group[0]);
      } else {
        consolidated.push(this.createConsolidatedEvent(group));
      }
    }

    this.sessionMemory = consolidated;
  }

  groupSimilarEvents() {
    const groups = [];
    const processed = new Set();

    for (let i = 0; i < this.sessionMemory.length; i++) {
      if (processed.has(i)) continue;

      const group = [this.sessionMemory[i]];
      processed.add(i);

      for (let j = i + 1; j < this.sessionMemory.length; j++) {
        if (processed.has(j)) continue;

        if (this.areEventsSimilar(this.sessionMemory[i], this.sessionMemory[j])) {
          group.push(this.sessionMemory[j]);
          processed.add(j);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  areEventsSimilar(event1, event2) {
    const timeDiff = Math.abs(
      new Date(event1.timestamp).getTime() -
      new Date(event2.timestamp).getTime()
    );

    // Do not merge events from different skills. Doing so can cause an event
    // from one skill to disappear into another skill's consolidated record.
    const skill1 = event1.skill || event1.metadata?.skill || null;
    const skill2 = event2.skill || event2.metadata?.skill || null;
    const sameSkill = skill1 === skill2;

    return sameSkill &&
      event1.category === event2.category &&
      event1.action === event2.action &&
      timeDiff < 60000;
  }

  createConsolidatedEvent(events) {
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    return {
      ...firstEvent,
      id: this.generateEventId(),
      timestamp: lastEvent.timestamp,
      contextSummary: `${firstEvent.contextSummary} (${events.length} similar events)`,
      metadata: {
        ...firstEvent.metadata,
        consolidatedCount: events.length,
        timeSpan: {
          start: firstEvent.timestamp,
          end: lastEvent.timestamp
        }
      }
    };
  }

  compressOldEvents() {
    const cutoffTime = Date.now() - (2 * 60 * 60 * 1000);

    this.sessionMemory = this.sessionMemory.map(event => {
      const eventTime = new Date(event.timestamp).getTime();

      if (
        eventTime < cutoffTime &&
        event.primaryContent &&
        event.primaryContent.length > 100
      ) {
        return {
          ...event,
          primaryContent: event.primaryContent.substring(0, 100) + '...[compressed]',
          compressed: true
        };
      }

      return event;
    });
  }

  getOptimizedHistory() {
    const recent = this.getRecentEvents(10);
    const important = this.getImportantEvents(5);
    const summary = this.generateSessionSummary();

    return {
      recent,
      important,
      summary,
      totalEvents: this.sessionMemory.length
    };
  }

  getRecentEvents(count = 10) {
    return this.sessionMemory
      .slice(-count)
      .map(event => ({
        timestamp: event.timestamp,
        action: event.action,
        category: event.category,
        summary: event.contextSummary,
        metadata: event.metadata
      }));
  }

  getImportantEvents(count = 5) {
    return this.sessionMemory
      .filter(event => ['capture', 'llm'].includes(event.category))
      .slice(-count)
      .map(event => ({
        timestamp: event.timestamp,
        category: event.category,
        summary: event.contextSummary,
        content: event.primaryContent?.substring(0, 150) || null
      }));
  }

  generateSessionSummary() {
    const categoryStats = this.getCategoryStatistics();
    const timeSpan = this.getSessionTimeSpan();
    const primaryActivities = this.getPrimaryActivities();

    return {
      duration: timeSpan,
      activities: categoryStats,
      focus: primaryActivities,
      eventCount: this.sessionMemory.length
    };
  }

  getCategoryStatistics() {
    const stats = {};

    this.sessionMemory.forEach(event => {
      stats[event.category] = (stats[event.category] || 0) + 1;
    });

    return stats;
  }

  getSessionTimeSpan() {
    if (this.sessionMemory.length === 0) return null;

    const timestamps = this.sessionMemory.map(e =>
      new Date(e.timestamp).getTime()
    );

    const start = Math.min(...timestamps);
    const end = Math.max(...timestamps);

    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      durationMs: end - start
    };
  }

  getPrimaryActivities() {
    const activities = {};

    this.sessionMemory.forEach(event => {
      if (event.metadata?.skill) {
        activities[event.metadata.skill] =
          (activities[event.metadata.skill] || 0) + 1;
      }
    });

    return Object.entries(activities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([skill, count]) => ({ skill, count }));
  }

  clear() {
    const eventCount = this.sessionMemory.length;

    this.sessionMemory = [];
    this.skillPrompts.clear();
    this.isInitialized = false;

    logger.info('Session memory cleared', { eventCount });

    // Reinitialize with skill prompts while retaining the currently selected skill.
    return this.initializeWithSkillPrompts();
  }

  getMemoryUsage() {
    const totalSize = JSON.stringify(this.sessionMemory).length;

    return {
      eventCount: this.sessionMemory.length,
      approximateSize: `${(totalSize / 1024).toFixed(2)} KB`,
      utilizationPercent: Math.round(
        (this.sessionMemory.length / this.maxSize) * 100
      )
    };
  }
}

module.exports = new SessionManager();