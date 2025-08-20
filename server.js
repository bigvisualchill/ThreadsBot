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

let runningPlatforms = new Set();

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/run', async (req, res) => {
  console.log('🔥 === POST /run ENDPOINT HIT ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('Received request:', {
    action: req.body?.action,
    platform: req.body?.platform,
    sessionName: req.body?.sessionName,
    headful: req.body?.headful
  });
  
  // Extract platform from request body
  const requestPlatform = req.body?.platform;
  
  if (!requestPlatform) {
    return res.status(400).json({ ok: false, error: 'Platform is required' });
  }
  
  if (runningPlatforms.has(requestPlatform)) {
    console.log(`Request blocked - ${requestPlatform} job already running`);
    return res.status(409).json({ ok: false, error: `A ${requestPlatform} job is already running. Please wait.` });
  }
  
  const {
    platform,
    action,
    url,
    comment,
    username: requestUsername,
    password: requestPassword,
    headful = false,
    sessionName = 'default',
    searchCriteria,
    maxPosts = 5,
    useAI = false,
    aiContext = '',
    likePost = false,
    assistantId,
  } = req.body || {};

  // Use environment variables if username/password not provided in request
  const envUser = (platform === 'instagram' || platform === 'threads') ? process.env.INSTAGRAM_USERNAME : process.env.X_USERNAME;
  const envPass = (platform === 'instagram' || platform === 'threads') ? process.env.INSTAGRAM_PASSWORD : process.env.X_PASSWORD;
  const username = requestUsername || envUser;
  const password = requestPassword || envPass;

  console.log(`📡 SERVER: Using username: ${username} for session: ${sessionName}`);

  try {
    runningPlatforms.add(requestPlatform);
    console.log('🚀 SERVER: About to call runAction');
    console.log('Starting runAction with:', { action, platform, sessionName, headful });
    console.log('🚀 SERVER: Calling runAction now...');
    
    const result = await runAction({
      platform,
      action,
      url,
      comment,
      username,
      password,
      headful: Boolean(headful),
      sessionName: sessionName || 'default',
      searchCriteria,
      maxPosts: parseInt(maxPosts, 10),
      useAI: Boolean(useAI),
      aiContext: aiContext || '',
      likePost: Boolean(likePost),
      assistantId,
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
    console.log(`Setting ${requestPlatform} as no longer running`);
    runningPlatforms.delete(requestPlatform);
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


