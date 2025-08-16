# CursorRead.MD - Puppeteer Social Documentation

## 1. Application Overview

**Puppeteer Social** is a sophisticated social media automation bot built with Node.js and Puppeteer that enables intelligent, AI-powered interactions on Instagram and X (Twitter). The application combines browser automation with OpenAI's GPT models to create contextual, human-like social media engagement.

### Core Functionality

- **Multi-Platform Support**: Automated interactions on Instagram and X (Twitter)
- **AI-Powered Comments**: Integration with OpenAI's Assistants API for intelligent, contextual comment generation
- **Session Management**: Persistent login sessions with multi-account support
- **Smart Discovery**: Hashtag and keyword-based post discovery with duplicate prevention
- **Web Interface**: User-friendly browser-based control panel
- **Headful/Headless Modes**: Option to run with visible browser for debugging or invisible for production
- **Comment Detection**: Advanced DOM analysis to prevent duplicate comments on the same posts

### Key Features

1. **Automated Actions**:
   - Like posts based on hashtags or keywords
   - Comment on posts with AI-generated or manual text
   - Follow users
   - Discover and analyze posts

2. **AI Integration**:
   - OpenAI Assistants API for contextual comment generation
   - Post content analysis for relevant responses
   - Customizable AI behavior and context

3. **Safety & Intelligence**:
   - Duplicate comment prevention with persistent caching
   - Rate limiting and human-like delays
   - Session persistence to avoid repeated logins
   - Comprehensive error handling and logging

4. **User Experience**:
   - Modern, responsive web interface
   - Real-time status updates
   - Multi-account session management
   - Dry-run mode for testing

### Technical Architecture

- **Backend**: Node.js with Express server
- **Automation**: Puppeteer with stealth plugins to avoid detection
- **AI**: OpenAI Assistants API for intelligent comment generation
- **Storage**: File-based session management and comment caching
- **Frontend**: Vanilla HTML/CSS/JavaScript with modern UI design

---

## 2. Development History

### Initial Development Phase
- **Core Architecture**: Established the foundational bot.js module with Puppeteer automation
- **Platform Support**: Implemented Instagram and X (Twitter) automation capabilities
- **Session Management**: Created persistent session storage system using cookies and localStorage
- **Web Interface**: Developed responsive HTML interface with tabbed navigation

### AI Integration Phase
- **OpenAI Integration**: Added OpenAI Assistants API integration for intelligent comment generation
- **Context Analysis**: Implemented post content extraction for contextual AI responses
- **Comment Intelligence**: Created sophisticated comment generation system with post analysis

### Advanced Features Phase
- **Duplicate Prevention**: Implemented advanced comment detection system (`igHasMyComment.js`)
- **Smart Discovery**: Added incremental post discovery with queue management
- **Multi-Account Support**: Enhanced session management for multiple accounts
- **Error Handling**: Comprehensive error handling and logging throughout the application

### User Experience Improvements
- **Modern UI**: Redesigned web interface with gradient styling and improved UX
- **Real-time Feedback**: Added comprehensive status updates and progress tracking
- **Session Management UI**: Created intuitive account management interface
- **Mobile Responsiveness**: Ensured compatibility across different screen sizes

### Current State
The application is feature-complete with:
- Stable multi-platform automation
- Intelligent AI-powered commenting
- Robust session and account management
- Professional web interface
- Comprehensive error handling and logging
- Advanced duplicate prevention
- Rate limiting and safety features

### File Structure
```
Puppeteer Social/
├── bot.js                      # Core automation engine
├── index.js                    # CLI interface
├── server.js                   # Web server and API
├── package.json                # Dependencies and scripts
├── public/
│   └── index.html             # Web interface
├── utils/
│   ├── igHasMyComment.js      # Comment detection utilities
│   └── commented-posts.json   # Comment cache
├── .sessions/                  # Stored login sessions
├── env-example.txt            # Environment configuration template
├── start.command              # macOS startup script
├── debug-server.sh            # Development debugging script
└── README.md                  # Project documentation
```

### Key Dependencies
- **puppeteer-extra**: Enhanced Puppeteer with stealth capabilities
- **openai**: Official OpenAI API client
- **express**: Web server framework
- **dotenv**: Environment variable management
- **cors**: Cross-origin resource sharing support

### Development Notes
- The application uses ES modules (type: "module" in package.json)
- Session data is stored locally in `.sessions/` directory
- Comment cache prevents duplicate interactions
- Stealth plugins help avoid bot detection
- The web interface uses vanilla JavaScript for simplicity and performance
