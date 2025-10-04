
import { InvokeOptions, Red } from '../..';

/**
 * The first node in redGraph, acting as an intelligent router.
 * It classifies the user query to determine if it requires external tools
 * (web search, URL scraping, system commands) or can be answered directly.
 * 
 * For conversational queries: routes directly to chat node (no tools)
 * For action queries: routes to toolPicker to select and execute relevant tools
 * 
 * @param state The current state of the graph.
 * @returns A partial state object indicating the next step.
 */
export const routerNode = async (state: any) => {
  const query = state.messages[state.messages.length - 1]?.content || '';
  const queryLower = query.toLowerCase();
  
  // Keyword-based detection first (fast path)
  const actionKeywords = [
    // Weather & Climate
    'weather', 'forecast', 'temperature', 'temp', 'climate', 'rain', 'snow', 'storm', 'hurricane',
    'wind', 'humidity', 'sunny', 'cloudy', 'hot', 'cold', 'freezing', 'precipitation',
    
    // News & Current Events
    'news', 'latest', 'recent', 'current', 'today', 'yesterday', 'breaking', 'headline',
    'update', 'happened', 'happening', 'event', 'announcement', 'report',
    
    // Search Intent
    'search', 'find', 'look up', 'lookup', 'google', 'check', 'show me', 'tell me about',
    'information about', 'details about', 'facts about',
    
    // Financial & Markets
    'price', 'cost', 'stock', 'bitcoin', 'crypto', 'cryptocurrency', 'btc', 'eth', 'ethereum',
    'market', 'trading', 'nasdaq', 'dow', 's&p', 'exchange rate', 'currency', 'forex',
    'dividend', 'investment', 'portfolio', 'ticker', 'share', 'value',
    
    // Sports & Games
    'score', 'game', 'match', 'tournament', 'championship', 'playoff', 'league',
    'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball',
    'team', 'player', 'stats', 'standings', 'schedule', 'live score',
    
    // Time & Business Hours
    'when does', 'what time', 'hours', 'open', 'close', 'closing time', 'opening time',
    'business hours', 'store hours', 'schedule', 'available', 'operating hours',
    
    // Location & Directions
    'where is', 'address', 'location', 'directions', 'near me', 'nearby', 'closest',
    'distance', 'how far', 'route', 'map', 'navigate',
    
    // Shopping & Products
    'buy', 'purchase', 'order', 'shop', 'store', 'available', 'in stock', 'out of stock',
    'deals', 'sale', 'discount', 'coupon', 'shipping', 'delivery',
    
    // Entertainment & Media
    'movie', 'show', 'tv', 'episode', 'season', 'release date', 'premiere', 'streaming',
    'netflix', 'spotify', 'youtube', 'review', 'rating', 'imdb', 'trailer',
    
    // Technology & Devices
    'iphone', 'android', 'laptop', 'computer', 'specs', 'specifications', 'release',
    'benchmark', 'comparison', 'vs', 'versus', 'better than', 'review',
    
    // Real-time Data
    'live', 'real-time', 'right now', 'currently', 'at the moment', 'status',
    'available now', 'updated', 'refresh',
    
    // Travel & Transportation
    'flight', 'plane', 'airport', 'train', 'bus', 'uber', 'taxi', 'traffic',
    'delay', 'arrival', 'departure', 'gate', 'terminal', 'hotel', 'booking',
    
    // Health & Medical
    'hospital', 'doctor', 'appointment', 'pharmacy', 'clinic', 'emergency',
    'symptoms', 'covid', 'vaccine', 'test results',
    
    // Restaurants & Food
    'restaurant', 'menu', 'reservation', 'delivery', 'takeout', 'order food',
    'uber eats', 'doordash', 'grubhub', 'yelp', 'reviews'
  ];
  
  const hasActionKeyword = actionKeywords.some(keyword => queryLower.includes(keyword));
  
  // Quick greetings check
  const isGreeting = /^(hi|hey|hello|sup|yo|what's up|whats up|wassup)[\s\?!]*$/i.test(query.trim());
  
  if (hasActionKeyword && !isGreeting) {
    console.log(`[Router] "${query.substring(0, 50)}..." → ACTION (keyword match)`);
    return { nextGraph: 'toolPicker' };
  }
  
  if (isGreeting) {
    console.log(`[Router] "${query.substring(0, 50)}..." → CONVERSATION (greeting)`);
    return { nextGraph: 'chat' };
  }
  
  // Fallback to LLM for ambiguous queries
  try {
    const classificationResult = await state.redInstance.localModel.invoke([
      {
        role: 'system',
        content: `Classify as ACTION or CONVERSATION. ACTION needs web search. CONVERSATION doesn't. Reply with ONE word only.`
      },
      {
        role: 'user',
        content: query
      }
    ]);

    const classification = classificationResult.content.toString().trim().toUpperCase();
    const isAction = classification.includes('ACTION');
    
    console.log(`[Router] "${query.substring(0, 50)}..." → ${isAction ? 'ACTION' : 'CONVERSATION'} (LLM fallback)`);
    
    if (isAction) {
      return { nextGraph: 'toolPicker' };
    } else {
      return { nextGraph: 'chat' };
    }
  } catch (error) {
    console.error('[Router] Classification error, defaulting to chat:', error);
    return { nextGraph: 'chat' };
  }
};