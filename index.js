import 'dotenv/config';
import { runAction } from './bot.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const part = argv[i];
    if (part.startsWith('--')) {
      const [keyRaw, valueRaw] = part.split('=');
      const key = keyRaw.replace(/^--/, '');
      const next = argv[i + 1];
      const value = valueRaw ?? (next && !next.startsWith('--') ? (i++, next) : 'true');
      args[key] = value;
    }
  }
  return args;
}

function printHelp() {
  const help = `
Usage: node index.js --platform <instagram|x> --action <login|like|comment|follow|discover|auto-comment> [options]

Options:
  --platform <name>       Platform: instagram|x
  --action <name>         Action: login|like|comment|follow|discover|auto-comment
  --url <url>             Target URL for like/comment/follow
  --comment <text>        Comment text (optional if using AI)
  --username <name>       Username (optional; falls back to env)
  --password <pass>       Password (optional; falls back to env)
  --headful               Run browser in non-headless mode
  --dry-run               Print what would happen, without launching the browser
  --session               Optional session name (defaults to default)
  
  # Search options (for discover/auto-comment)
  --hashtag <tag>         Hashtag to search for (e.g., #personalgrowth)
  --keywords <words>      Keywords to search for
  --max-posts <number>    Maximum posts to process (default: 5)
  
  # AI options
  --use-ai                Use AI to generate comments
  --ai-context <text>     Additional context for AI

Examples:
  # Discover posts by hashtag
  node index.js --platform instagram --action discover --hashtag personalgrowth
  
  # Auto-comment with AI
  node index.js --platform instagram --action auto-comment --hashtag motivation --use-ai --ai-context "I'm a fitness coach"
  
  # Manual comment with AI
  node index.js --platform x --action comment --url https://x.com/user/status/123 --use-ai --ai-context "Keep it casual"
`;
  console.log(help);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    printHelp();
    return;
  }

  const platform = (args.platform || '').toLowerCase();
  const action = (args.action || '').toLowerCase();
  const url = args.url;
  const comment = args.comment;
  const headful = Boolean(args.headful && args.headful !== 'false');
  const dryRun = Boolean(args['dry-run'] || args.dryRun || args.dryrun);
  const sessionName = args.session || 'default';
  
  // Search criteria
  const hashtag = args.hashtag;
  const keywords = args.keywords;
  const maxPosts = parseInt(args['max-posts'] || args.maxPosts || '5', 10);
  
  // AI options
  const useAI = Boolean(args['use-ai'] || args.useAi || args.useai);
  const aiContext = args['ai-context'] || args.aiContext || '';

  const envUser = platform === 'instagram' ? process.env.INSTAGRAM_USERNAME : process.env.X_USERNAME;
  const envPass = platform === 'instagram' ? process.env.INSTAGRAM_PASSWORD : process.env.X_PASSWORD;
  const username = args.username || envUser;
  const password = args.password || envPass;

  if (!platform || !['instagram', 'x'].includes(platform)) {
    printHelp();
    throw new Error('Invalid or missing --platform');
  }
  if (!action || !['login', 'like', 'comment', 'follow', 'discover', 'auto-comment'].includes(action)) {
    printHelp();
    throw new Error('Invalid or missing --action');
  }
  if (['like', 'comment', 'follow'].includes(action) && !url) {
    throw new Error('--url is required for like/comment/follow');
  }
  if (action === 'comment' && !comment && !useAI) {
    throw new Error('--comment is required for comment action (or use --use-ai)');
  }
  if (['discover', 'auto-comment'].includes(action) && !hashtag && !keywords) {
    throw new Error('--hashtag or --keywords is required for discover/auto-comment actions');
  }

  if (dryRun) {
    console.log('[DRY RUN] Would execute:', { 
      platform, action, url, headful, sessionName, 
      searchCriteria: hashtag || keywords ? { hashtag, keywords } : undefined,
      useAI, aiContext 
    });
    return;
  }

  const searchCriteria = hashtag || keywords ? { hashtag, keywords } : undefined;
  
  const result = await runAction({ 
    platform, action, url, comment, username, password, 
    headful, dryRun: false, sessionName, searchCriteria, 
    maxPosts, useAI, aiContext 
  });
  
  if (result?.message) console.log(result.message);
  if (result?.posts) {
    console.log(`\nFound ${result.posts.length} posts:`);
    result.posts.forEach((post, i) => console.log(`${i + 1}. ${post}`));
  }
  if (result?.results) {
    console.log(`\nResults:`);
    result.results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.success ? '✅' : '❌'} ${r.url}${r.comment ? ': ' + r.comment : ''}`);
    });
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});


