// ===== BLUESKY FUNCTIONS =====

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
    
    // Look for login form
    const loginButton = await page.waitForSelector('button[type="submit"], [data-testid*="signIn"], [aria-label*="Sign in"]', { timeout: 5000 });
    
    if (!loginButton) {
      throw new Error('Could not find login button on Bluesky');
    }
    
    // Find username/email field
    await page.waitForSelector('input[type="text"], input[name*="identifier"], input[placeholder*="handle"]', { timeout: 5000 });
    await page.type('input[type="text"], input[name*="identifier"], input[placeholder*="handle"]', username);
    
    // Find password field
    await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await page.type('input[type="password"]', password);
    
    // Click login
    await loginButton.click();
    await sleep(3000);
    
    // Verify login success
    const loginSuccess = await page.evaluate(() => {
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]');
      return !!composeButton;
    });
    
    if (loginSuccess) {
      console.log('✅ Bluesky login successful');
      return true;
    } else {
      throw new Error('Login appeared to fail - compose button not found');
    }
    
  } catch (error) {
    console.error('❌ Bluesky login error:', error.message);
    throw new Error(`Bluesky login error: ${error.message}`);
  }
}

async function blueskyLike(page, postUrl) {
  console.log(`❤️ Attempting to like Bluesky post: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  const likeSelectors = ['[aria-label*="Like"]', '[data-testid*="like"]', 'button[aria-label*="like"]'];
  
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
  
  try {
    // Look for reply button
    const replyButton = await page.waitForSelector('[aria-label*="Reply"], [data-testid*="reply"], button[aria-label*="reply"]', { timeout: 5000 });
    await replyButton.click();
    await sleep(1000);
    
    // Look for comment textarea
    const textarea = await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 5000 });
    await textarea.click();
    await textarea.type(comment);
    await sleep(1000);
    
    // Look for submit button
    const submitButton = await page.waitForSelector('button[type="submit"], [data-testid*="post"], [aria-label*="Post"]', { timeout: 5000 });
    await submitButton.click();
    
    console.log('✅ Bluesky comment posted successfully!');
    return { success: true };
    
  } catch (error) {
    console.error('❌ Bluesky comment error:', error.message);
    throw new Error(`Bluesky comment error: ${error.message}`);
  }
}

async function discoverBlueskyPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🦋 Starting Bluesky post discovery`);
  
  const { hashtag, keywords } = searchCriteria;
  let searchQuery = hashtag || keywords;
  
  if (!searchQuery) {
    throw new Error('Either hashtag or keywords must be provided');
  }
  
  const searchUrl = `https://bsky.app/search?q=${encodeURIComponent(searchQuery)}`;
  console.log(`🔍 Navigating to: ${searchUrl}`);
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
  
  console.log(`🦋 Found ${posts.length} potential Bluesky posts`);
  return posts.slice(0, maxPosts);
}