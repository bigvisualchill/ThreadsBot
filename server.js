import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { runAction } from './bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enable CORS for all routes
app.use(cors());

app.use(express.json({ limit: '1mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  console.log('Health check received');
  res.json({ ok: true });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/run', async (req, res) => {
  console.log('POST /run received:', req.body);
  
  try {
    const { action, platform, sessionName, username, password, assistantId, headful, searchCriteria, maxPosts, useAI, comment, likePost } = req.body;
    
    // Validate required fields
    if (!action || !platform) {
      return res.status(400).json({
        ok: false,
        message: 'Missing required fields: action and platform'
      });
    }
    
    // For testing, return a simple response first
    if (action === 'test') {
      return res.json({
        ok: true,
        message: 'Test endpoint working - server is connected to UI',
        received: req.body
      });
    }
    
    // For login testing without browser
    if (action === 'login-test') {
      return res.json({
        ok: true,
        message: 'Login test endpoint working - server received login request',
        received: req.body
      });
    }
    
    // Call the actual bot action
    console.log(`🚀 Starting bot action: ${action} for ${platform}`);
    
    const result = await runAction({
      action,
      platform,
      sessionName: sessionName || 'default',
      username,
      password,
      assistantId,
      headful: headful || false,
      searchCriteria,
      maxPosts: maxPosts || 5,
      useAI: useAI || false,
      comment,
      likePost: likePost || false
    });
    
    console.log(`✅ Bot action completed:`, result);
    
    res.json({
      ok: true,
      message: 'Action completed successfully',
      result
    });
    
  } catch (error) {
    console.error('Error in /run endpoint:', error);
    res.status(500).json({
      ok: false,
      message: error.message || 'Internal server error'
    });
  }
});

const PORT = process.env.PORT || 3000;

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`UI server listening on http://localhost:${PORT}`);
  console.log('Server started successfully, ready to handle requests');
});

// Keep the process alive
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});


