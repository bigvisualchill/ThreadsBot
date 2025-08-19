// ===== BLUESKY FUNCTIONS =====

async function ensureBlueskyLoggedIn(page, { username, password }) {
  console.log('🦋 Checking Bluesky login status...');
  
  try {
    await page.goto('https://bsky.app/', { waitUntil: 'networkidle2' });
    await sleep(2000);
    
    // Check if already logged in by looking for compose button or user menu
    const isLoggedIn = await page.evaluate(() => {
      // Look for compose button, user menu, or feed indicators
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]') ||
                           document.querySelector('button[aria-label*="Write a post"]');
      const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                      document.querySelector('[data-testid*="profile"]');
      const feedIndicator = document.querySelector('[aria-label*="Timeline"]') ||
                           document.querySelector('[data-testid*="feed"]');
      
      return !!(composeButton || userMenu || feedIndicator);
    });
    
    if (isLoggedIn) {
      console.log('✅ Already logged into Bluesky');
      return true;
    }
    
    console.log('🔐 Not logged in, proceeding with login...');
    
    // Look for sign in button
    const signInSelectors = [
      'button[aria-label*="Sign in"]',
      'a[href*="signin"]',
      '[data-testid*="signin"]',
      'button[data-testid*="sign-in"]'
    ];
    
    let signInClicked = false;
    for (const selector of signInSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector);
        signInClicked = true;
        break;
      } catch (error) {
        continue;
      }
    }
    
    if (!signInClicked) {
      // Try text-based clicking as fallback
      signInClicked = await clickByText(page, 'Sign in');
    }
    
    if (!signInClicked) {
      throw new Error('Could not find sign in button');
    }
    
    await sleep(2000);
    
    // Fill in username/handle
    console.log('📝 Filling in username...');
    const usernameSelectors = [
      'input[placeholder*="Enter your handle"]',
      'input[placeholder*="Handle"]',
      'input[type="text"]',
      'input[data-testid*="handle"]',
      'input[name*="identifier"]'
    ];
    
    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        usernameField = await page.$(selector);
        if (usernameField) break;
      } catch (error) {
        continue;
      }
    }
    
    if (!usernameField) {
      throw new Error('Could not find username field');
    }
    
    await usernameField.click();
    await sleep(500);
    await usernameField.type(username, { delay: 100 });
    
    // Fill in password
    console.log('🔒 Filling in password...');
    const passwordSelectors = [
      'input[type="password"]',
      'input[placeholder*="Password"]',
      'input[data-testid*="password"]',
      'input[name*="password"]'
    ];
    
    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        passwordField = await page.$(selector);
        if (passwordField) break;
      } catch (error) {
        continue;
      }
    }
    
    if (!passwordField) {
      throw new Error('Could not find password field');
    }
    
    await passwordField.click();
    await sleep(500);
    await passwordField.type(password, { delay: 100 });
    
    // Submit login form
    console.log('🚀 Submitting login form...');
    const submitSelectors = [
      'button[type="submit"]',
      'button[aria-label*="Sign in"]',
      'button[data-testid*="signin"]'
    ];
    
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector);
        submitted = true;
        break;
      } catch (error) {
        continue;
      }
    }
    
    if (!submitted) {
      // Try text-based clicking as fallback
      submitted = await clickByText(page, 'Sign in');
    }
    
    if (!submitted) {
      // Try pressing Enter as fallback
      await page.keyboard.press('Enter');
    }
    
    // Wait for login to complete
    console.log('⏳ Waiting for login to complete...');
    await sleep(5000);
    
    // Verify login success
    const loginSuccess = await page.evaluate(() => {
      const composeButton = document.querySelector('[aria-label*="Compose"]') || 
                           document.querySelector('[data-testid*="compose"]') ||
                           document.querySelector('button[aria-label*="Write a post"]');
      const userMenu = document.querySelector('[aria-label*="Profile"]') || 
                      document.querySelector('[data-testid*="profile"]');
      
      return !!(composeButton || userMenu);
    });
    
    if (loginSuccess) {
      console.log('✅ Bluesky login successful!');
      return true;
    } else {
      throw new Error('Login verification failed');
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
  
  // Try multiple selectors for the like button
  const likeSelectors = [
    '[aria-label*="Like"]',
    '[data-testid*="like"]',
    'button[aria-label*="Like"]',
    'button[data-testid*="like"]',
    '[role="button"][aria-label*="Like"]',
    'svg[aria-label*="Like"]'
  ];
  
  console.log(`🔍 Looking for like button...`);
  let likeClicked = false;
  for (const selector of likeSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        // Check if already liked (avoid double-liking)
        const isAlreadyLiked = await page.evaluate((el) => {
          const ariaLabel = el.getAttribute('aria-label') || '';
          const className = el.className || '';
          return ariaLabel.includes('Unlike') || className.includes('liked') || className.includes('active');
        }, element);
        
        if (isAlreadyLiked) {
          console.log('⏭️ Post already liked, skipping...');
          return { success: true, skipped: true, reason: 'Already liked' };
        }
        
        console.log(`✅ Found like button with selector: ${selector}`);
        console.log(`🖱️ Clicking like button...`);
        await element.click();
        console.log(`✅ Like button clicked successfully`);
        likeClicked = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }
  
  if (!likeClicked) {
    // Try text-based clicking as fallback
    likeClicked = await clickByText(page, 'Like');
    if (likeClicked) {
      console.log(`✅ Like clicked via text-based method`);
    }
  }
  
  if (!likeClicked) {
    throw new Error('Could not find like button on Bluesky post');
  }
  
  await sleep(1000); // Wait for like to register
  console.log('✅ Bluesky post liked successfully!');
  return { success: true };
}

async function blueskyComment(page, postUrl, comment) {
  console.log(`💬 Attempting to comment on Bluesky post: ${postUrl}`);
  console.log(`💬 Comment text: "${comment}"`);
  
  await page.goto(postUrl, { waitUntil: 'networkidle2' });
  await sleep(1000);
  
  // Try multiple selectors for the reply button
  const replySelectors = [
    '[aria-label*="Reply"]',
    '[data-testid*="reply"]',
    'button[aria-label*="Reply"]',
    'button[data-testid*="reply"]',
    '[role="button"][aria-label*="Reply"]',
    'svg[aria-label*="Reply"]'
  ];
  
  console.log(`🔍 Looking for reply button...`);
  let replyClicked = false;
  for (const selector of replySelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      if (element) {
        console.log(`✅ Found reply button with selector: ${selector}`);
        console.log(`🖱️ Clicking reply button...`);
        await element.click();
        console.log(`✅ Reply button clicked successfully`);
        replyClicked = true;
        break;
      }
    } catch (error) {
      continue;
    }
  }
  
  if (!replyClicked) {
    // Try text-based clicking as fallback
    replyClicked = await clickByText(page, 'Reply');
    if (replyClicked) {
      console.log(`✅ Reply clicked via text-based method`);
    }
  }
  
  if (!replyClicked) {
    throw new Error('Could not find reply button on Bluesky post');
  }
  
  console.log(`⏳ Waiting for comment composer to appear...`);
  await sleep(1000);
  
  console.log(`🔍 Looking for comment textarea...`);
  // Try multiple selectors for the comment textarea
  const textareaSelectors = [
    'textarea[placeholder*="Write your reply"]',
    'textarea[data-testid*="composer"]',
    'textarea[aria-label*="Reply"]',
    'div[contenteditable="true"]',
    'textarea',
    '[data-testid*="textInput"] textarea',
    '[role="textbox"]'
  ];
  
  let textareaElement = null;
  for (const selector of textareaSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      textareaElement = await page.$(selector);
      if (textareaElement) {
        console.log(`✅ Found textarea with selector: ${selector}`);
        break;
      }
    } catch (error) {
      continue;
    }
  }
  
  if (!textareaElement) {
    throw new Error('Could not find comment textarea');
  }
  
  // Clear and type comment
  console.log(`⌨️ Typing comment...`);
  await textareaElement.click();
  await sleep(500);
  
  // Clear existing content
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.press('Backspace');
  await sleep(200);
  
  // Type comment with proper delay
  await textareaElement.type(comment, { delay: 80 });
  await sleep(1000);
  
  // Submit comment
  console.log(`🚀 Submitting comment...`);
  const submitSelectors = [
    'button[aria-label*="Post reply"]',
    'button[data-testid*="post"]',
    'button[type="submit"]'
  ];
  
  let submitted = false;
  for (const selector of submitSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      await page.click(selector);
      submitted = true;
      break;
    } catch (error) {
      continue;
    }
  }
  
  if (!submitted) {
    // Try text-based clicking as fallback
    submitted = await clickByText(page, 'Reply') || await clickByText(page, 'Post');
  }
  
  if (!submitted) {
    // Try keyboard shortcut as fallback
    console.log('🔄 Trying keyboard shortcut (Cmd+Enter)...');
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    submitted = true;
  }
  
  await sleep(3000); // Wait for comment to post
  console.log('✅ Bluesky comment posted successfully!');
  return { success: true };
}

async function discoverBlueskyPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🦋 Starting Bluesky post discovery with criteria:`, searchCriteria);
  console.log(`🎯 Target: ${maxPosts} posts`);
  
  const { hashtag, keywords } = searchCriteria;
  let searchQuery = '';
  
  if (hashtag && hashtag.trim()) {
    searchQuery = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
  } else if (keywords && keywords.trim()) {
    searchQuery = keywords;
  } else {
    throw new Error('Either hashtag or keywords must be provided');
  }
  
  console.log(`🔍 Search query: "${searchQuery}"`);
  
  // Navigate to search
  const searchUrl = `https://bsky.app/search?q=${encodeURIComponent(searchQuery)}`;
  console.log(`🌐 Navigating to: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle2' });
  await sleep(3000);
  
  const posts = [];
  let scrollAttempts = 0;
  const maxScrolls = 10;
  
  while (posts.length < maxPosts && scrollAttempts < maxScrolls) {
    console.log(`📜 Scroll attempt ${scrollAttempts + 1}/${maxScrolls} (found ${posts.length}/${maxPosts} posts)`);
    
    // Extract post URLs from current view
    const newPosts = await page.evaluate(() => {
      const postElements = document.querySelectorAll('a[href*="/post/"]');
      const urls = [];
      
      postElements.forEach(element => {
        const href = element.getAttribute('href');
        if (href && href.includes('/post/')) {
          const fullUrl = href.startsWith('http') ? href : `https://bsky.app${href}`;
          urls.push(fullUrl);
        }
      });
      
      return [...new Set(urls)]; // Remove duplicates
    });
    
    // Add new posts to our collection
    const beforeCount = posts.length;
    newPosts.forEach(url => {
      if (!posts.includes(url)) {
        posts.push(url);
      }
    });
    
    console.log(`📊 Found ${newPosts.length} post links, added ${posts.length - beforeCount} new unique posts`);
    
    if (posts.length >= maxPosts) {
      break;
    }
    
    // Scroll down to load more posts
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(2000);
    scrollAttempts++;
    
    // Check if no new content loaded
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    await sleep(1000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === newHeight && posts.length === beforeCount) {
      console.log('📄 No new content loaded, stopping scroll');
      break;
    }
  }
  
  const finalPosts = posts.slice(0, maxPosts);
  console.log(`✅ Discovery complete: Found ${finalPosts.length} Bluesky posts`);
  
  return finalPosts;
}
