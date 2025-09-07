const puppeteer = require('puppeteer');
const fs = require('fs');
const BASE_URL = 'https://www.fibromyalgiaforums.org';
const MAIN_FORUM_URL = `${BASE_URL}/community/`;

// Helper function for controlled delays
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Retry function with exponential backoff
async function withRetry(fn, maxRetries = 3, initialDelay = 2000) {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries > maxRetries) throw error;

      console.log(`Attempt ${retries} failed: ${error.message}`);
      console.log(`Retrying in ${initialDelay * retries}ms...`);
      await delay(initialDelay * retries); // Exponential backoff
    }
  }
}

(async () => {
  // Use let instead of const for variables that will be reassigned
  let browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-features=site-per-process' // Helps with frame issues
    ],
    protocolTimeout: 180000 // Increase to 3 minutes
  });

  let page = await browser.newPage();

  // Set longer default navigation timeout
  page.setDefaultNavigationTimeout(90000); // 90 seconds

  let allThreads = [];
  let processedThreads = 0;

  try {
    console.log('🌐 Fetching main forum categories...');

    await withRetry(async () => {
      await page.goto(MAIN_FORUM_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    });

    const categories = await page.$$eval('div.node-main a[href^="/community/forums/"]', links =>
      links.map(link => ({
        name: link.textContent.trim(),
        url: link.href
      }))
    );

    for (const category of categories) {
      console.log(`\n📂 Scraping category: ${category.name}`);

      for (let pageNum = 1; pageNum <= 3; pageNum++) {
        const categoryUrl = pageNum === 1 ? category.url : `${category.url}page-${pageNum}`;
        console.log(` 🔗 Category page ${pageNum}: ${categoryUrl}`);

        try {
          await withRetry(async () => {
            await page.goto(categoryUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            });
          });

          const threads = await page.$$eval('div.structItem--thread', threadNodes =>
            threadNodes.map(thread => {
              const titleEl = thread.querySelector('div.structItem-title a');

              // FIXED: Better extraction of replies and views
              let replies = null;
              let views = null;

              // Try to find pairs--inline elements
              const pairsElements = thread.querySelectorAll('dl.pairs--inline');
              pairsElements.forEach(pair => {
                const label = pair.querySelector('dt')?.textContent.toLowerCase().trim();
                const value = pair.querySelector('dd')?.textContent.trim();

                if (label && value) {
                  if (label.includes('repl')) {
                    replies = value;
                  } else if (label.includes('view')) {
                    views = value;
                  }
                }
              });

              return {
                title: titleEl?.textContent.trim(),
                thread_url: titleEl ? titleEl.href : null,
                replies: replies,
                views: views
              };
            })
          );

          // Process threads with a limit to avoid memory issues
          for (const thread of threads) {
            if (!thread.thread_url) continue;

            console.log(` 🧵 Scraping thread: ${thread.title}`);

            // Create a new page for each thread
            const threadPage = await browser.newPage();
            threadPage.setDefaultNavigationTimeout(90000);

            try {
              await withRetry(async () => {
                await threadPage.goto(thread.thread_url, {
                  waitUntil: 'domcontentloaded',
                  timeout: 90000
                });
              });

              // FIXED: Extract thread views directly from thread page
              const threadViewsCount = await threadPage.evaluate(() => {
                // Try multiple selectors to find view count
                const selectors = [
                  'div.p-description',
                  'div.p-body-pageContent',
                  'div.block-outer-main'
                ];

                for (const selector of selectors) {
                  const element = document.querySelector(selector);
                  if (element) {
                    const text = element.textContent;
                    const viewMatch = text.match(/(\d+(?:\.\d+)?[kK]?)\s*views?/i);
                    if (viewMatch) return viewMatch[1];
                  }
                }

                return null;
              });

              // Use thread view count from thread page if found, otherwise use from listing
              if (threadViewsCount) {
                thread.views = threadViewsCount;
              }

              const thread_id = thread.thread_url.replace(/\/$/, '').split('/').pop();
              let posts = [];
              let pageNum = 1;

              while (true) {
                console.log(` 📄 Thread page ${pageNum}`);

                try {
                  await threadPage.waitForSelector('article.message--post', { timeout: 10000 });

                  const pagePosts = await threadPage.$$eval('article.message--post', nodes => {
                    return nodes.map(node => {
                      const username = node.querySelector('h4.message-name')?.textContent.trim();
                      const timestamp = node.querySelector('time')?.getAttribute('datetime');
                      const content = node.querySelector('div.bbWrapper')?.textContent.trim();
                      const user_title = node.querySelector('h5.userTitle')?.textContent.trim();

                      // FIXED: Improved quote extraction
                      let quote = null;
                      // First try bbCodeBlock--quote which is the forum's quote format
                      const quoteBlock = node.querySelector('div.bbCodeBlock--quote');
                      if (quoteBlock) {
                        const quoteContent = quoteBlock.querySelector('div.bbCodeBlock-content');
                        if (quoteContent) {
                          const attribution = quoteBlock.querySelector('div.bbCodeBlock-sourceJump');
                          const attributionText = attribution ? attribution.textContent.trim() : '';
                          quote = (attributionText ? attributionText + ': ' : '') + quoteContent.textContent.trim();
                        }
                      } else {
                        // Fallback to blockquote
                        const blockquote = node.querySelector('blockquote');
                        if (blockquote) {
                          quote = blockquote.textContent.trim();
                        }
                      }

                      const post_id = node.getAttribute('data-content') || null;

                      // User info box
                      const profileItems = node.querySelectorAll('dl.pairs--justified');
                      let joined = null, messages = null, country = null, state = null;

                      profileItems.forEach(pair => {
                        const label = pair.querySelector('dt')?.textContent.trim().toLowerCase();
                        const value = pair.querySelector('dd')?.textContent.trim();

                        if (label?.includes('join')) joined = value;
                        if (label?.includes('message')) messages = value;
                        if (label?.includes('location') || label?.includes('country')) country = value;
                        if (label?.includes('state')) state = value;
                      });

                      return {
                        username,
                        user_title,
                        timestamp,
                        content,
                        quote,
                        post_id,
                        joined,
                        messages,
                        country,
                        state
                      };
                    });
                  });

                  posts.push(...pagePosts);

                  // Check for next page button
                  const hasNextPage = await threadPage.evaluate(() => {
                    return !!document.querySelector('a.pageNav-jump--next');
                  });

                  if (!hasNextPage) break;

                  // Click next page with retry
                  await withRetry(async () => {
                    try {
                      await Promise.all([
                        threadPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                        threadPage.click('a.pageNav-jump--next')
                      ]);
                    } catch (e) {
                      // If navigation times out but click was successful, continue anyway
                      if (!e.message.includes('Navigation timeout')) throw e;
                    }
                  });

                  pageNum++;
                  await delay(1500); // Delay between pages

                } catch (err) {
                  console.error(`  ⚠️ Error on thread page ${pageNum}: ${err.message}`);
                  break; // Stop processing pages for this thread
                }
              }

              const threadData = {
                thread_id,
                thread_title: thread.title,
                thread_url: thread.thread_url,
                thread_views: thread.views,
                thread_replies: posts.length - 1,
                forum_category: category.name,
                original_post: posts[0] || null,
                replies: posts.slice(1)
              };

              allThreads.push(threadData);
              processedThreads++;

              console.log(` ✅ Scraped ${posts.length} posts\n`);

              // Save intermediate results every 5 threads
              if (processedThreads % 5 === 0) {
                const tempFilename = `fibro_forum_data_partial_${processedThreads}.json`;
                fs.writeFileSync(tempFilename, JSON.stringify(allThreads, null, 2));
                console.log(`💾 Saved partial results to ${tempFilename}`);
              }

            } catch (err) {
              console.error(`❌ Failed to scrape thread: ${thread.title} → ${err.message}`);
            } finally {
              await threadPage.close();
              await delay(3000 + Math.random() * 2000); // Random delay between threads
            }

            // Restart browser if needed to prevent memory issues
            if (processedThreads % 10 === 0) {
              console.log("🔄 Restarting browser to prevent memory issues...");
              await browser.close();
              await delay(5000);
              // Recreate browser and page
              browser = await puppeteer.launch({
                headless: true,
                args: [
                  '--no-sandbox',
                  '--disable-setuid-sandbox',
                  '--disable-gpu',
                  '--disable-dev-shm-usage',
                  '--disable-accelerated-2d-canvas',
                  '--disable-features=site-per-process'
                ],
                protocolTimeout: 180000
              });
              page = await browser.newPage();
              page.setDefaultNavigationTimeout(90000);
            }
          }

        } catch (err) {
          console.error(`❌ Failed category page ${pageNum}: ${err.message}`);
        }

        // Add delay between category pages
        await delay(5000);
      }
    }

    // Save final results
    fs.writeFileSync('fibro_forum_data_full.json', JSON.stringify(allThreads, null, 2));
    console.log('\n✅ All threads saved to fibro_forum_data_full.json');

  } catch (err) {
    console.error(`💥 Top-level error: ${err.message}`);

    // Save whatever data we have so far
    if (allThreads.length > 0) {
      fs.writeFileSync('fibro_forum_data_recovery.json', JSON.stringify(allThreads, null, 2));
      console.log('⚠️ Partial data saved to fibro_forum_data_recovery.json');
    }
  } finally {
    await browser.close();
  }
})();
