require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!GEMINI_API_KEY || !DISCORD_WEBHOOK_URL) {
  console.error('Missing required environment variables: GEMINI_API_KEY and/or DISCORD_WEBHOOK_URL');
  process.exit(1);
}

const RSS_FEEDS = [
  'http://feeds.bbci.co.uk/news/rss.xml',
  'https://www.reuters.com/rssfeed/worldNews',
  'https://techcrunch.com/feed/',
  'https://www.theverge.com/rss/index.xml'
];

async function fetchRSSFeed(url) {
  try {
    const response = await fetch(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    return parseRSS(xml);
  } catch (error) {
    console.error(`Failed to fetch RSS from ${url}:`, error.message);
    return [];
  }
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) || [];
  
  for (const itemXml of matches.slice(0, 5)) {
    const title = extractTag(itemXml, 'title');
    const description = extractTag(itemXml, 'description');
    
    if (title) {
      items.push({
        title: cleanText(title),
        description: cleanText(description)
      });
    }
  }
  
  return items;
}

function extractTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>|<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? (match[1] || match[2] || '').trim() : '';
}

function cleanText(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAllHeadlines() {
  const allHeadlines = [];
  
  for (const feedUrl of RSS_FEEDS) {
    const headlines = await fetchRSSFeed(feedUrl);
    allHeadlines.push(...headlines);
  }
  
  return allHeadlines.slice(0, 15);
}

async function generateSummaryWithGemini(headlines) {
  const headlinesText = headlines.map((h, i) => 
    `${i + 1}. ${h.title}${h.description ? '\n' + h.description : ''}`
  ).join('\n\n');

  const prompt = `You are a news summarizer. Based on the following news headlines and descriptions, generate exactly 5 concise bullet points that summarize today's key news. Use neutral, factual tone. No emojis. Each bullet point should be one clear sentence.

Headlines:
${headlinesText}

Provide only the 5 bullet points, one per line, starting with a dash (-). Output nothing else.`;

  const requestBody = JSON.stringify({
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 500
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: requestBody,
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
    throw new Error('Invalid Gemini API response structure');
  }

  const text = data.candidates[0].content.parts[0].text;
  
  if (!text || text.trim().length === 0) {
    throw new Error('Gemini returned empty response');
  }

  return normalizeBulletPoints(text);
}

function normalizeBulletPoints(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const bullets = [];
  
  for (const line of lines) {
    let cleaned = line;
    if (cleaned.match(/^[-*•]\s*/)) {
      cleaned = cleaned.replace(/^[-*•]\s*/, '');
    } else if (cleaned.match(/^\d+\.\s*/)) {
      cleaned = cleaned.replace(/^\d+\.\s*/, '');
    }
    
    if (cleaned.length > 0) {
      bullets.push(`- ${cleaned}`);
    }
    
    if (bullets.length === 5) {
      break;
    }
  }
  
  if (bullets.length === 0) {
    throw new Error('Failed to extract bullet points from Gemini response');
  }
  
  while (bullets.length < 5) {
    bullets.push('- No additional news available.');
  }
  
  return bullets.slice(0, 5).join('\n');
}

async function postToDiscord(summary) {
  const today = new Date().toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric' 
  });

  const message = `**Daily Brief – ${today}**\n\n${summary}`;

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: message }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Discord webhook error: ${response.status}`);
  }

  console.log('Successfully posted to Discord');
}

async function main() {
  try {
    console.log('Fetching news headlines from RSS feeds...');
    const headlines = await fetchAllHeadlines();
    
    if (headlines.length === 0) {
      console.error('No headlines fetched from any RSS feed');
      process.exit(1);
    }

    console.log(`Fetched ${headlines.length} headlines`);

    console.log('Generating summary with Gemini...');
    const summary = await generateSummaryWithGemini(headlines);

    console.log('Posting to Discord...');
    await postToDiscord(summary);

    console.log('Daily brief completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();