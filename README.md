# Puppeteer Social Media Bot

A powerful social media automation bot built with Puppeteer that can perform various actions on Instagram and other social media platforms.

## Features

- **Instagram Automation**: Like, comment, and discover posts
- **Session Management**: Save and load user sessions to maintain login state
- **Headful/Headless Mode**: Run with or without visible browser window
- **Web Interface**: User-friendly web UI for controlling the bot
- **Duplicate Prevention**: Smart tracking to avoid processing the same posts multiple times
- **AI Comment Generation**: Optional OpenAI integration for generating comments

## Installation

1. Clone the repository:
```bash
git clone https://github.com/bigvisualchill/PuppeteerSocial.git
cd PuppeteerSocial
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables (optional):
```bash
cp .env.example .env
# Edit .env and add your OpenAI API key if you want AI comment generation
```

## Usage

### Starting the Bot

Run the start script:
```bash
./start.command
```

Or manually:
```bash
node server.js
```

The web interface will be available at `http://localhost:3000`

### Web Interface

1. **Login & Setup**: First, log in to your Instagram account and save a session
2. **Actions**: Choose from various actions like:
   - Like posts
   - Comment on posts
   - Discover posts
   - Auto-comment with AI

### Configuration

- **Headful Mode**: Check this to see the browser window during automation
- **Max Posts**: Set the maximum number of posts to process
- **Search Criteria**: Use hashtags or keywords to find specific content

## File Structure

- `bot.js` - Core automation logic
- `server.js` - Web server and API endpoints
- `public/index.html` - Web interface
- `.sessions/` - Stored user sessions
- `start.command` - macOS startup script

## Security

- API keys and sensitive data are stored in `.env` file (not tracked in Git)
- Session data is stored locally in `.sessions/` directory
- The bot respects rate limits and includes delays between actions

## Dependencies

- Puppeteer - Browser automation
- Express - Web server
- OpenAI (optional) - AI comment generation

## License

This project is for educational purposes. Please respect social media platforms' terms of service and use responsibly.

## Disclaimer

This tool is for educational and personal use only. Users are responsible for complying with social media platforms' terms of service and applicable laws. The developers are not responsible for any misuse of this software.
