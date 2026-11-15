const fs = require('fs');
const path = require('path');

class PromptLoader {
  constructor() {
    this.prompts = new Map();
    this.promptsLoaded = false;
    this.skillPromptSent = new Set();

    // Skills that require programming-language-specific context.
    this.skillsRequiringProgrammingLanguage = ['dsa'];
  }

  /**
   * Load all skill prompts from the prompts directory.
   * Every valid Markdown file represents an available skill.
   */
  loadPrompts() {
    if (this.promptsLoaded) {
      return;
    }

    const promptsDir = path.join(__dirname, 'prompts');

    try {
      const files = fs.readdirSync(promptsDir);

      for (const file of files) {
        // Only process Markdown files.
        if (!file.toLowerCase().endsWith('.md')) {
          continue;
        }

        const filePath = path.join(promptsDir, file);

        // Ignore directories and non-file entries.
        if (!fs.statSync(filePath).isFile()) {
          continue;
        }

        // Use lowercase filenames as canonical skill identifiers.
        const skillName = path
          .basename(file, path.extname(file))
          .trim()
          .toLowerCase();

        if (!skillName) {
          continue;
        }

        const promptContent = fs.readFileSync(filePath, 'utf8');

        // Ignore empty prompt files.
        if (!promptContent.trim()) {
          console.warn(`Skipping empty skill prompt: ${file}`);
          continue;
        }

        this.prompts.set(skillName, promptContent);
      }

      this.promptsLoaded = true;

      console.log(
        `Successfully loaded ${this.prompts.size} skill prompts:`,
        this.getAvailableSkills()
      );

    } catch (error) {
      console.error('Error loading skill prompts:', error);

      throw new Error(
        `Failed to load skill prompts: ${error.message}`
      );
    }
  }

  /**
   * Get the system prompt for a specific skill.
   *
   * @param {string} skillName
   * @param {string|null} programmingLanguage
   * @returns {string|null}
   */
  getSkillPrompt(skillName, programmingLanguage = null) {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const normalizedSkillName = this.normalizeSkillName(skillName);

    let promptContent = this.prompts.get(normalizedSkillName);

    if (!promptContent) {
      return null;
    }

    // Inject programming-language context only when required.
    if (
      programmingLanguage &&
      this.requiresProgrammingLanguage(normalizedSkillName)
    ) {
      promptContent = this.injectProgrammingLanguage(
        promptContent,
        programmingLanguage,
        normalizedSkillName
      );
    }

    return promptContent;
  }

  /**
   * Inject programming-language context into skill prompts.
   *
   * @param {string} promptContent
   * @param {string} programmingLanguage
   * @param {string} skillName
   * @returns {string}
   */
  injectProgrammingLanguage(
    promptContent,
    programmingLanguage,
    skillName
  ) {
    const languageMap = {
      cpp: 'C++',
      c: 'C',
      python: 'Python',
      java: 'Java',
      javascript: 'JavaScript',
      js: 'JavaScript'
    };

    const fenceTagMap = {
      cpp: 'cpp',
      c: 'c',
      python: 'python',
      java: 'java',
      javascript: 'javascript',
      js: 'javascript'
    };

    const normalizedLanguage = String(programmingLanguage || '')
      .trim()
      .toLowerCase();

    const languageTitle =
      languageMap[normalizedLanguage] ||
      (
        normalizedLanguage
          ? normalizedLanguage.charAt(0).toUpperCase() +
            normalizedLanguage.slice(1)
          : 'Text'
      );

    const fenceTag =
      fenceTagMap[normalizedLanguage] ||
      normalizedLanguage ||
      'text';

    const languageUpper = languageTitle.toUpperCase();

    let languageInjection = '';

    switch (skillName) {
      case 'dsa':

        languageInjection = `

## IMPLEMENTATION LANGUAGE: ${languageUpper}

STRICT REQUIREMENTS:

- Respond ONLY in ${languageTitle}. Do not include any snippets or alternatives in other languages.
- All code blocks must use triple backticks with the exact language tag: \`\`\`${fenceTag}\`\`\`.
- Aim for the best possible time and space complexity; prefer optimal algorithms and data structures.
- Provide: brief approach, then final ${languageTitle} implementation, followed by time/space complexity.
- If the user's input is a problem statement (and does not include code), produce a complete, runnable ${languageTitle} solution without asking for clarification.
- Avoid unnecessary verbosity; focus on correctness, clarity, and efficiency.`;

        break;

      default:

        languageInjection = `

## PROGRAMMING LANGUAGE: ${languageUpper}

All code and examples must be in ${languageTitle}.
Use code fences with tag: \`\`\`${fenceTag}\`\`\`.`;

        break;
    }

    return promptContent + languageInjection;
  }

  /**
   * Check whether this is the first interaction.
   *
   * @param {Array} storedMemory
   * @returns {boolean}
   */
  isFirstTimeInteraction(storedMemory) {
    return !storedMemory || storedMemory.length === 0;
  }

  /**
   * Check whether a skill prompt should be sent as model memory.
   *
   * @param {string} skillName
   * @param {Array} storedMemory
   * @returns {boolean}
   */
  shouldSendAsModelMemory(skillName, storedMemory) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    if (this.isFirstTimeInteraction(storedMemory)) {
      return true;
    }

    const hasSkillInMemory = storedMemory.some(
      event =>
        event.skillUsed === normalizedSkillName &&
        event.promptSentAsMemory === true
    );

    return !hasSkillInMemory;
  }

  /**
   * Prepare Gemini API request with model memory or regular message.
   *
   * @param {string} skillName
   * @param {string} userMessage
   * @param {Array} storedMemory
   * @param {string|null} programmingLanguage
   * @returns {Object}
   */
  prepareGeminiRequest(
    skillName,
    userMessage,
    storedMemory,
    programmingLanguage = null
  ) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    const skillPrompt = this.getSkillPrompt(
      normalizedSkillName,
      programmingLanguage
    );

    const requestConfig = {
      model: 'gemini-pro',
      contents: [],
      systemInstruction: null,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    };

    if (
      this.shouldSendAsModelMemory(
        normalizedSkillName,
        storedMemory
      )
    ) {
      if (skillPrompt) {
        requestConfig.systemInstruction = {
          parts: [{ text: skillPrompt }]
        };

        requestConfig.contents.push({
          role: 'user',
          parts: [{ text: userMessage }]
        });

        this.skillPromptSent.add(normalizedSkillName);

        return {
          ...requestConfig,
          isUsingModelMemory: true,
          skillUsed: normalizedSkillName,
          programmingLanguage
        };
      } else {
        console.warn(
          `No system prompt found for skill: ${normalizedSkillName}`
        );
      }
    }

    // Regular message when the skill prompt has already been sent.
    requestConfig.contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    return {
      ...requestConfig,
      isUsingModelMemory: false,
      skillUsed: normalizedSkillName,
      programmingLanguage
    };
  }

  /**
   * Get separate components for manual API construction.
   *
   * @param {string} skillName
   * @param {string} userMessage
   * @param {Array} storedMemory
   * @param {string|null} programmingLanguage
   * @returns {Object}
   */
  getRequestComponents(
    skillName,
    userMessage,
    storedMemory,
    programmingLanguage = null
  ) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    const shouldUseModelMemory =
      this.shouldSendAsModelMemory(
        normalizedSkillName,
        storedMemory
      );

    const skillPrompt = this.getSkillPrompt(
      normalizedSkillName,
      programmingLanguage
    );

    return {
      skillName: normalizedSkillName,
      userMessage,
      skillPrompt,
      shouldUseModelMemory,
      isFirstTime: this.isFirstTimeInteraction(storedMemory),
      modelMemory:
        shouldUseModelMemory && skillPrompt
          ? skillPrompt
          : null,
      messageContent: userMessage,
      programmingLanguage,
      requiresProgrammingLanguage:
        this.requiresProgrammingLanguage(normalizedSkillName)
    };
  }

  /**
   * Update stored memory after a successful API call.
   *
   * @param {Array} storedMemory
   * @param {string} skillName
   * @param {boolean} wasModelMemoryUsed
   * @param {string} userMessage
   * @param {string} aiResponse
   * @param {string|null} programmingLanguage
   * @returns {Array}
   */
  updateStoredMemory(
    storedMemory,
    skillName,
    wasModelMemoryUsed,
    userMessage,
    aiResponse,
    programmingLanguage = null
  ) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    const updatedMemory = [...(storedMemory || [])];

    const memoryEntry = {
      timestamp: new Date().toISOString(),
      skillUsed: normalizedSkillName,
      promptSentAsMemory: wasModelMemoryUsed,
      userMessage,
      aiResponse: aiResponse
        ? aiResponse.substring(0, 200) + '...'
        : null,
      action: wasModelMemoryUsed
        ? 'MODEL_MEMORY_SENT'
        : 'REGULAR_MESSAGE',
      programmingLanguage: programmingLanguage || null
    };

    updatedMemory.push(memoryEntry);

    return updatedMemory;
  }

  /**
   * Process a user request.
   *
   * @param {string} skillName
   * @param {string} userMessage
   * @param {Array} storedMemory
   * @param {string|null} programmingLanguage
   * @returns {Promise<Object>}
   */
  async processUserRequest(
    skillName,
    userMessage,
    storedMemory,
    programmingLanguage = null
  ) {
    try {
      const components = this.getRequestComponents(
        skillName,
        userMessage,
        storedMemory,
        programmingLanguage
      );

      const geminiRequest = this.prepareGeminiRequest(
        skillName,
        userMessage,
        storedMemory,
        programmingLanguage
      );

      return {
        requestReady: true,
        geminiRequest,
        components,
        needsMemoryUpdate: true,
        programmingLanguage
      };

    } catch (error) {
      console.error('Error processing user request:', error);

      return {
        requestReady: false,
        error: error.message,
        programmingLanguage
      };
    }
  }

  /**
   * Check whether a skill requires programming-language context.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  requiresProgrammingLanguage(skillName) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    return this.skillsRequiringProgrammingLanguage.includes(
      normalizedSkillName
    );
  }

  /**
   * Get skills that require programming-language context.
   *
   * @returns {Array<string>}
   */
  getSkillsRequiringProgrammingLanguage() {
    return [...this.skillsRequiringProgrammingLanguage];
  }

  /**
   * Normalize skill names to match prompt filenames.
   *
   * @param {string} skillName
   * @returns {string}
   */
  normalizeSkillName(skillName) {
    if (
      typeof skillName !== 'string' ||
      !skillName.trim()
    ) {
      return 'general';
    }

    const normalized = skillName.toLowerCase().trim();

    const skillMap = {
      'dsa': 'dsa',
      'data-structures': 'dsa',
      'algorithms': 'dsa',
      'data-structures-algorithms': 'dsa',

      'behavioral': 'behavioral',
      'behavioral-interview': 'behavioral',
      'behavior': 'behavioral',

      'sales': 'sales',
      'selling': 'sales',
      'business-development': 'sales',

      'presentation': 'presentation',
      'presentations': 'presentation',
      'public-speaking': 'presentation',

      'data-science': 'data-science',
      'datascience': 'data-science',
      'machine-learning': 'data-science',
      'ml': 'data-science',

      'programming': 'programming',
      'coding': 'programming',
      'software-development': 'programming',
      'development': 'programming',

      'devops': 'devops',
      'dev-ops': 'devops',
      'infrastructure': 'devops',

      'system-design': 'system-design',
      'systems-design': 'system-design',
      'architecture': 'system-design',
      'distributed-systems': 'system-design',

      'negotiation': 'negotiation',
      'negotiating': 'negotiation',
      'conflict-resolution': 'negotiation'
    };

    return skillMap[normalized] || normalized;
  }

  /**
   * Get dynamically discovered available skills.
   *
   * Every valid .md file inside the prompts directory
   * is considered an available skill.
   *
   * @returns {Array<string>}
   */
  getAvailableSkills() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    return Array.from(this.prompts.keys()).sort();
  }

  /**
   * Reset prompt tracking for a new session.
   */
  resetSession() {
    this.skillPromptSent.clear();
  }

  /**
   * Get current session statistics.
   *
   * @returns {Object}
   */
  getSessionStats() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    return {
      totalPrompts: this.prompts.size,
      skillsUsedInSession: this.skillPromptSent.size,
      availableSkills: this.getAvailableSkills(),
      skillsUsed: Array.from(this.skillPromptSent),
      skillsRequiringProgrammingLanguage:
        this.skillsRequiringProgrammingLanguage
    };
  }
}

// Export singleton instance.
const promptLoader = new PromptLoader();

module.exports = {
  PromptLoader,
  promptLoader
};