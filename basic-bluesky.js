// ===== BASIC BLUESKY FUNCTIONS =====

async function ensureBlueskyLoggedIn(page, { username, password }) {
  console.log('🦋 Checking Bluesky login status...');
  try {
    await page.goto('https://bsky.app/', { waitUntil: 'networkidle2' });
    await sleep(2000);
    
    const isLoggedIn = await page.evaluate(() => {
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]');
      const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                      document.querySelector('[data-testid*="profile"]');
      return !!(composeButton || userMenu);
    });
    
    if (isLoggedIn) {
      console.log('✅ Already logged into Bluesky');
      return true;
    }
    
    console.log('🔐 Proceeding with login...');
    throw new Error('Bluesky login implementation needed - please implement full login flow');
    
  } catch (error) {
    console.error('❌ Bluesky login error:', error.message);
    throw new Error(`Bluesky login error: ${error.message}`);
  }
}

async function blueskyLike(page, postUrl) {
  console.log(`❤️ Attempting to like Bluesky post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  const likeSelectors = ['[aria-label*="Like"]', '[data-testid*="like"]'];
  
  for (const selector of likeSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        await element.click();
        console.log('✅ Bluesky post liked successfully!');
        return { success: true };
      }
    } catch (error) {
      continue;
    }
  }
  
  throw new Error('Could not find like button on Bluesky post');
}

async function blueskyComment(page, postUrl, comment) {
  console.log(`💬 Attempting to comment on Bluesky post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  throw new Error('Bluesky comment implementation needed - please implement full comment flow');
}

async function discoverBlueskyPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🦋 Starting Bluesky post discovery`);
  
  const { hashtag, keywords } = searchCriteria;
  let searchQuery = hashtag || keywords;
  
  if (!searchQuery) {
    throw new Error('Either hashtag or keywords must be provided');
  }
  
  const searchUrl = `https://bsky.app/search?q=${encodeURIComponent(searchQuery)}`;
  await page.goto(searchUrl, { waitUntil: 'networkidle2' });
  await sleep(3000);
  
  const posts = await page.evaluate(() => {
    const postElements = document.querySelectorAll('a[href*="/post/"]');
    const urls = [];
    
    postElements.forEach(element => {
      const href = element.getAttribute('href');
      if (href && href.includes('/post/')) {
        const fullUrl = href.startsWith('http') ? href : `https://bsky.app${href}`;
        urls.push(fullUrl);
      }
    });
    
    return [...new Set(urls)];
  });
  
  return posts.slice(0, maxPosts);
}
