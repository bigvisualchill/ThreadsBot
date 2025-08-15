import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAction } from './bot.js';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Add CORS support
app.use(cors());

// Add basic request logging
app.use((req, res, next) => {
  console.log(`📡 SERVER: ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let isRunning = false;

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/run', async (req, res) => {
  console.log('Received request:', {
    action: req.body?.action,
    platform: req.body?.platform,
    sessionName: req.body?.sessionName,
    headful: req.body?.headful
  });
  
  if (isRunning) {
    console.log('Request blocked - job already running');
    return res.status(409).json({ ok: false, error: 'A job is already running. Please wait.' });
  }
  
  const {
    platform,
    action,
    url,
    comment,
    username: requestUsername,
    password: requestPassword,
    headful = false,
    dryRun = false,
    sessionName = 'default',
    searchCriteria,
    maxPosts = 5,
    useAI = false,
    aiContext = '',
  } = req.body || {};

  // Use environment variables if username/password not provided in request
  const envUser = platform === 'instagram' ? process.env.INSTAGRAM_USERNAME : process.env.X_USERNAME;
  const envPass = platform === 'instagram' ? process.env.INSTAGRAM_PASSWORD : process.env.X_PASSWORD;
  const username = requestUsername || envUser;
  const password = requestPassword || envPass;

  console.log(`📡 SERVER: Using username: ${username} for session: ${sessionName}`);

  try {
    isRunning = true;
    console.log('Starting runAction with:', { action, platform, sessionName, headful });
    
    const result = await runAction({
      platform,
      action,
      url,
      comment,
      username,
      password,
      headful: Boolean(headful),
      dryRun: Boolean(dryRun),
      sessionName: sessionName || 'default',
      searchCriteria,
      maxPosts: parseInt(maxPosts, 10),
      useAI: Boolean(useAI),
      aiContext: aiContext || '',
    });
    
    console.log('runAction completed with result:', { ok: result.ok, message: result.message });
    res.json(result);
  } catch (err) {
    console.error('Server error details:', {
      message: err.message,
      name: err.name,
      stack: err.stack,
      toString: err.toString()
    });
    res.status(400).json({ ok: false, error: err.message || err.toString() || String(err) });
  } finally {
    console.log('Setting isRunning to false');
    isRunning = false;
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


