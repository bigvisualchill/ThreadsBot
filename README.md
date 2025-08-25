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
- **🔄 Enhanced Sequencer** - Loop functionality and content source selection
- **🎯 Smart Content Filtering** - Automatic filtering of low-quality posts
- **🤖 AI Text Processing** - Automatic formatting of AI-generated content

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

### Enhanced Sequencer Features
- **Loop Functionality**: Repeat entire sequences with configurable loop count
- **Content Source Selection**: Choose between Search Posts or For You Feed
- **Smart Content Filtering**: Automatically skip posts with <5 words or video content
- **AI Text Processing**: Automatic formatting of em/en dashes in AI comments
- **Real-time Status Tracking**: Live updates with loop progress indicators

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

#### 1. "Duplicate comments being posted" (FIXED)
- **Cause**: Duplicate event handlers in sequencer causing double API calls
- **Solution**: Fixed duplicate event handlers and improved comment submission logic
- **Status**: ✅ Resolved in v2.1.0

#### 2. "Sequence continues looping after completion" (FIXED)
- **Cause**: Incorrect completion logic in sequencer
- **Solution**: Added proper completion handling and browser notifications
- **Status**: ✅ Resolved in v2.1.0

#### 3. "Could not find username field"
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

#### 5. "Assistant ID not available" (Fixed)
- **Cause**: Assistant ID not being retrieved from session during auto-comment
- **Solution**: Enhanced session data retrieval to include assistant ID
- **Status**: ✅ Assistant ID now properly saved and retrieved

#### 6. "Navigation timeout" (Fixed)
- **Cause**: Inconsistent domain usage (threads.net vs threads.com)
- **Solution**: Standardized all navigation to use threads.com domain
- **Status**: ✅ All navigation now uses consistent domain

#### 7. "Login verification mismatch" (Fixed)
- **Cause**: Login verification logic too strict and not matching browser state
- **Solution**: Simplified verification to check for main page without login form
- **Status**: ✅ Login success now matches actual browser state

### Debug Logging
Enable verbose logging by setting:
```bash
DEBUG=true
LOG_LEVEL=debug
```

## 🔧 Recent Fixes & Improvements

### Latest Critical Fixes (January 2025)
- **✅ Duplicate Comments Fixed**: Resolved issue where bot was posting two comments per post
- **✅ Sequencer Duplicate Execution**: Fixed duplicate event handlers causing double API calls
- **✅ Sequence Completion Logic**: Added proper completion handling with browser notifications
- **✅ Comment Detection Enhanced**: Improved comment detection with better logging and verification
- **✅ Comment Submission Improved**: Added delays and verification to prevent double posting
- **✅ Browser Notifications**: Added completion notifications and alerts for sequence status

### Previous Critical Fixes (August 2024)
- **✅ Assistant ID Retrieval**: Fixed assistant ID not being retrieved from session during auto-comment
- **✅ Login Verification**: Improved login verification logic to match actual browser state
- **✅ Logout Function**: Fixed logout to use Puppeteer methods instead of direct DOM access
- **✅ Navigation Timeout**: Fixed navigation timeout by using correct threads.com domain
- **✅ Session Management**: Enhanced session handling with better error recovery

### Previous Critical Bug Fixes
- **✅ Syntax Error Resolution**: Fixed try-catch block mismatches in `threads-functions.js`
- **✅ Login Flow Overhaul**: Implemented direct navigation instead of broken button clicks
- **✅ Instagram SSO Removal**: Eliminated Instagram dependency for reliable login
- **✅ Enhanced Error Handling**: Added comprehensive error recovery and reporting

### Performance Enhancements
- **✅ Faster Startup**: Removed unnecessary dependencies and optimized loading
- **✅ Better Memory Management**: Improved session handling and cleanup
- **✅ Reduced Network Calls**: Optimized API interactions and caching
- **✅ Reliable Navigation**: Fixed domain consistency issues for better performance

### Current Status (January 2025)
- **✅ Login System**: Fully functional with reliable verification
- **✅ Session Management**: Robust session saving and loading
- **✅ Assistant ID Integration**: Properly retrieves and uses OpenAI assistant ID
- **✅ Auto-comment**: Working with AI-powered comment generation (no duplicate comments)
- **✅ Sequencer System**: Fixed duplicate execution and added completion notifications
- **✅ Comment Detection**: Enhanced detection with comprehensive logging
- **✅ Logout**: Clean logout with proper session cleanup
- **✅ Error Handling**: Comprehensive error recovery and reporting

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

### v2.2.0 - Enhanced Sequencer & Content Filtering (Latest)
- ✅ **Loop Functionality**: Replaced Loop action with Loop settings (checkbox + count field)
- ✅ **Content Source Selection**: Added dropdown for Search Posts vs For You Feed
- ✅ **For You Feed Discovery**: Implemented post discovery from Threads For You feed
- ✅ **Content Filtering**: Skips posts with <5 words OR video content
- ✅ **Text Processing**: AI comments automatically replace em/en dashes with commas
- ✅ **Modal UI Improvements**: Comment settings now show by default
- ✅ **Simplified Comments Tab**: Removed hashtag field, simplified to keywords only
- ✅ **Enhanced Sequencer**: Improved loop functionality and status tracking

### v2.1.0 - Duplicate Comments & Sequencer Fixes
- ✅ **Duplicate Comments Fixed**: Resolved issue where bot posted two comments per post
- ✅ **Sequencer Duplicate Execution**: Fixed duplicate event handlers causing double API calls
- ✅ **Sequence Completion Logic**: Added proper completion handling with browser notifications
- ✅ **Comment Detection Enhanced**: Improved detection with better logging and verification
- ✅ **Comment Submission Improved**: Added delays and verification to prevent double posting
- ✅ **Browser Notifications**: Added completion notifications and alerts for sequence status

### v2.0.0 - Complete Overhaul
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
*Latest Version: v2.2.0 - Enhanced Sequencer & Content Filtering*