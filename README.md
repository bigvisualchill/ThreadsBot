# Threads Bot 🤖

A sophisticated automation tool for Threads (Meta's text-based social platform) built with Node.js, Puppeteer, and modern web technologies. This bot provides intelligent social media automation with AI-powered features and comprehensive debugging capabilities.

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Development History](#-development-history)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [API Endpoints](#-api-endpoints)
- [Debugging & Troubleshooting](#-debugging--troubleshooting)
- [Recent Fixes & Improvements](#-recent-fixes--improvements)
- [Technical Details](#-technical-details)
- [Contributing](#-contributing)

## ✨ Features

### Core Functionality
- **🎯 Intelligent Login System** - Username/password authentication with multiple fallback methods
- **❤️ Automated Likes** - Smart post liking with configurable limits
- **💬 AI-Powered Comments** - OpenAI integration for contextual commenting
- **🔄 Session Management** - Persistent browser sessions with recovery
- **📊 Real-time Progress Tracking** - Live updates during automation runs
- **🛡️ Safety Features** - Built-in delays and rate limiting

### Advanced Features
- **🔍 Comprehensive Debugging** - Screenshots and detailed logging at every step
- **🎨 Modern Web Interface** - Clean, responsive UI with real-time updates
- **📈 Analytics & Reporting** - Performance metrics and success tracking
- **🔧 Flexible Configuration** - Easy setup and customization
- **🚨 Error Handling** - Robust error recovery and reporting

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web Interface │────│     Server      │────│   Puppeteer     │
│   (Express)     │    │   (Node.js)     │    │   Automation     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
    ┌─────────┐            ┌─────────┐            ┌─────────┐
    │  HTML   │            │  REST    │            │ Threads  │
    │   CSS   │            │   API    │            │  Browser │
    │   JS    │            │Endpoints │            │ Instance │
    └─────────┘            └─────────┘            └─────────┘
```

### Technology Stack
- **Backend**: Node.js + Express.js
- **Automation**: Puppeteer (headless Chrome)
- **Frontend**: HTML5 + CSS3 + JavaScript
- **AI Integration**: OpenAI API (for comments)
- **Session Storage**: File-based session management

## 📚 Development History

### Phase 1: Initial Development
- **🎯 Goal**: Create a basic Threads automation bot
- **✅ Achieved**: Core functionality for likes and comments
- **🔧 Tech**: Basic Puppeteer setup with simple web interface

### Phase 2: Instagram SSO Integration
- **🎯 Goal**: Streamlined login process via Instagram
- **✅ Achieved**: OAuth-based authentication
- **❌ Issues**: Instagram API changes broke functionality

### Phase 3: Major Overhaul & Debugging
- **🎯 Goal**: Fix critical bugs and improve reliability
- **✅ Major Fixes**:
  - Resolved syntax errors in `threads-functions.js`
  - Implemented direct username/password login
  - Added comprehensive debugging system
  - Enhanced error handling and recovery

### Phase 4: Production-Ready Enhancement
- **🎯 Goal**: Create a robust, maintainable solution
- **✅ Current Status**: Fully functional with enterprise-grade features

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager
- OpenAI API key (for AI commenting features)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/bigvisualchill/ThreadsBot.git
   cd ThreadsBot
   ```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment:**
   ```bash
   cp env-example.txt .env
   # Edit .env with your configuration
   ```

4. **Start the server:**
   ```bash
   ./start.command
   # Or manually: node server.js
   ```

5. **Access the web interface:**
   Open `http://localhost:3000` in your browser

## ⚙️ Configuration

### Environment Variables
Create a `.env` file with the following variables:

```bash
# Server Configuration
PORT=3000
NODE_ENV=development

# OpenAI Configuration (for AI commenting)
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_ASSISTANT_ID=your_assistant_id_here

# Bot Configuration
DEFAULT_USERNAME=your_threads_username
DEFAULT_PASSWORD=your_threads_password

# Session Management
SESSION_TIMEOUT=3600000
MAX_SESSIONS=5
```

### Bot Settings
Configure automation parameters in the web interface:
- **Target Users/Hashtags**: Define what content to interact with
- **Interaction Limits**: Set maximum likes/comments per session
- **Timing**: Configure delays between actions
- **AI Prompts**: Customize comment generation prompts

## 📡 API Endpoints

### Core Endpoints

#### POST `/run`
Execute automation tasks
```json
{
  "action": "login|like|comment|discover",
  "platform": "threads",
  "sessionName": "unique_session_id",
  "username": "your_username",
  "password": "your_password",
  "assistantId": "openai_assistant_id",
  "headful": true
}
```

#### GET `/status`
Get current bot status
```json
{
  "running": false,
  "currentAction": null,
  "lastRun": "2024-01-15T10:30:00Z"
}
```

#### POST `/stop`
Stop current automation
```json
{
  "success": true,
  "message": "Automation stopped successfully"
}
```

## 🔍 Debugging & Troubleshooting

### Debug Screenshots
The bot automatically captures screenshots at key points:
- `debug-login-start.png` - Initial Threads page
- `debug-after-login-navigation.png` - After navigating to login page
- `debug-after-enter-key.png` - After form submission
- `debug-login-verification-failed.png` - When verification fails

### Common Issues & Solutions

#### 1. "Could not find username field"
- **Cause**: Login page structure changed or navigation failed
- **Solution**: Check `debug-after-login-navigation.png` to see actual page
- **Fix**: The bot now uses direct navigation to `https://www.threads.com/login`

#### 2. "Login verification failed"
- **Cause**: Form submission didn't work or page didn't load properly
- **Solution**: Check `debug-after-enter-key.png` and `debug-login-verification-failed.png`
- **Fix**: Multiple form submission methods (Enter key, button click, programmatic)

#### 3. "Syntax errors" (Fixed)
- **Cause**: Mismatched try-catch blocks and indentation issues
- **Solution**: Complete code restructure with proper syntax
- **Status**: ✅ Resolved in latest version

#### 4. "Instagram SSO not working" (Fixed)
- **Cause**: Instagram API changes and OAuth issues
- **Solution**: Removed Instagram dependency entirely
- **Status**: ✅ Now uses direct username/password login only

### Debug Logging
Enable verbose logging by setting:
```bash
DEBUG=true
LOG_LEVEL=debug
```

## 🔧 Recent Fixes & Improvements

### Critical Bug Fixes
- **✅ Syntax Error Resolution**: Fixed try-catch block mismatches in `threads-functions.js`
- **✅ Login Flow Overhaul**: Implemented direct navigation instead of broken button clicks
- **✅ Instagram SSO Removal**: Eliminated Instagram dependency for reliable login
- **✅ Enhanced Error Handling**: Added comprehensive error recovery and reporting

### Performance Enhancements
- **✅ Faster Startup**: Removed unnecessary dependencies and optimized loading
- **✅ Better Memory Management**: Improved session handling and cleanup
- **✅ Reduced Network Calls**: Optimized API interactions and caching

### Debugging Improvements
- **✅ Visual Debugging**: Screenshots at every critical step
- **✅ Element Inspection**: Detailed logging of page elements and selectors
- **✅ URL Tracking**: Complete navigation path logging
- **✅ Error Analysis**: Enhanced error messages with context

### Code Quality
- **✅ Clean Architecture**: Separated concerns and improved maintainability
- **✅ Documentation**: Comprehensive inline comments and this README
- **✅ Type Safety**: Better error handling and validation
- **✅ Version Control**: Complete backup to GitHub repository

## 🔧 Technical Details

### File Structure
```
ThreadsBot/
├── server.js                 # Main Express server
├── bot.js                    # Core automation logic
├── threads-functions.js      # Threads-specific functions
├── start.command            # Startup script
├── public/
│   └── index.html           # Web interface
├── utils/
│   ├── threads-commented-posts.json  # Comment tracking
│   └── threadsHasMyComment.js        # Comment detection
└── debug-*.png              # Debug screenshots
```

### Key Components

#### threads-functions.js
- **ensureThreadsLoggedIn()**: Main login functionality
- **threadsLike()**: Post liking automation
- **threadsComment()**: AI-powered commenting
- **discoverThreadsPosts()**: Content discovery

#### bot.js
- **runAction()**: Main automation coordinator
- **launchBrowser()**: Browser initialization
- **session management**: Persistent browser sessions

#### server.js
- **Express server**: API endpoints and web interface
- **Progress tracking**: Real-time status updates
- **Error handling**: Centralized error management

### Security Features
- **🔒 Session Isolation**: Each session runs in separate browser instance
- **🛡️ Rate Limiting**: Built-in delays to prevent detection
- **🔐 Credential Protection**: Secure handling of login information
- **📊 Activity Logging**: Complete audit trail of all actions

### Performance Optimization
- **🚀 Headless Mode**: Configurable headless/browser mode
- **⚡ Smart Timeouts**: Adaptive timeouts based on network conditions
- **💾 Memory Management**: Automatic cleanup and resource optimization
- **🔄 Connection Pooling**: Efficient browser instance reuse

## 🤝 Contributing

### Development Setup
1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit with descriptive messages
5. Push to your fork and create a Pull Request

### Code Standards
- **ES6+ Features**: Use modern JavaScript syntax
- **Async/Await**: Prefer async/await over promises
- **Error Handling**: Comprehensive try-catch blocks
- **Documentation**: Inline comments for complex logic
- **Testing**: Test all changes before committing

### Reporting Issues
When reporting bugs, please include:
- **Debug Screenshots**: `debug-*.png` files from your run
- **Console Output**: Complete error logs
- **Environment**: Node.js version, OS, browser version
- **Steps to Reproduce**: Detailed reproduction steps

## 📈 Version History

### v2.0.0 - Complete Overhaul (Latest)
- ✅ **Major Bug Fixes**: Resolved critical syntax and login issues
- ✅ **Architecture Redesign**: Clean separation of concerns
- ✅ **Enhanced Debugging**: Comprehensive screenshot and logging system
- ✅ **Direct Login**: Removed Instagram dependency
- ✅ **Production Ready**: Enterprise-grade error handling

### v1.5.0 - Instagram Integration
- 🔄 **OAuth Implementation**: Instagram SSO integration
- ⚠️ **Deprecated**: Instagram API changes broke functionality

### v1.0.0 - Initial Release
- 🎯 **Core Features**: Basic like and comment automation
- 🏗️ **Foundation**: Basic architecture and web interface

## 📄 License

This project is private and proprietary. All rights reserved.

## 👨‍💻 Author

**bigvisualchill** - [GitHub](https://github.com/bigvisualchill)

---

## 🚨 Important Notes

- **Use Responsibly**: Follow Threads' terms of service and community guidelines
- **Rate Limiting**: Built-in delays prevent account restrictions
- **Testing**: Always test in a controlled environment first
- **Backup**: Regular backups are essential for data safety
- **Updates**: Keep dependencies updated for security and performance

---

*Last updated: January 2025*
*Repository: https://github.com/bigvisualchill/ThreadsBot.git*