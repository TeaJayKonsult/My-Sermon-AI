// api/generate-sermon.js
const https = require('https');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Helper: get days remaining until next month
function getDaysUntilNextMonth(date) {
  const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  const diff = nextMonth - date;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ====== VERIFY FIREBASE TOKEN ======
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) return res.status(500).json({ error: 'FIREBASE_API_KEY missing' });

  let userId;
  try {
    const verifyData = JSON.stringify({ idToken });
    const verifyRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:lookup?key=${firebaseApiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(verifyData) }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) reject(new Error(`Token verification failed: ${response.statusCode}`));
          else {
            const parsed = JSON.parse(raw);
            if (parsed.users && parsed.users.length) resolve(parsed.users[0]);
            else reject(new Error('No user found'));
          }
        });
      });
      request.on('error', reject);
      request.write(verifyData);
      request.end();
    });
    userId = verifyRes.localId;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // ====== PARSE REQUEST BODY ======
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { topic, scripture } = body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });

  // ====== USER USAGE TRACKING ======
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  let userData = userDoc.exists ? userDoc.data() : null;

  if (!userData) {
    const now = new Date();
    await userRef.set({
      plan: 'free',               // free | pro (future)
      generationsUsedThisMonth: 0,
      monthlyResetDate: now.toISOString(),
      createdAt: now.toISOString()
    });
    userData = { plan: 'free', generationsUsedThisMonth: 0, monthlyResetDate: now.toISOString() };
  }

  // Check monthly reset
  const lastReset = new Date(userData.monthlyResetDate);
  const now = new Date();

  if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
    await userRef.update({
      generationsUsedThisMonth: 0,
      monthlyResetDate: now.toISOString()
    });
    userData.generationsUsedThisMonth = 0;
  }

  // Determine limit
  const limit = userData.plan === 'pro' ? 15 : 5;

  // Check if limit reached
  if (userData.generationsUsedThisMonth >= limit) {
    const remainingDays = getDaysUntilNextMonth(now);
    return res.status(429).json({
      error: 'limit_reached',
      message: `You've used all ${limit} free sermons this month. Your limit resets in ${remainingDays} days.`,
      remainingDays: remainingDays,
      limit: limit,
      used: userData.generationsUsedThisMonth
    });
  }

  // ====== CALL GROQ API ======
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return res.status(500).json({ error: 'GROQ_API_KEY missing' });

  const systemPrompt = `You are a seasoned Nigerian pastor and theologian with deep knowledge of Scripture. You have been preaching and teaching for decades.

Your task is to generate a complete, deep, and reflective sermon that moves the heart and challenges the mind. Use Nigerian English and your grammar should be easy to understand. 

The sermon should be pastorally warm, theologically sound, and practically applicable. Avoid shallow clichés. Go deep.

STRUCTURE:

1. OPENING PRAYER: A prayer that sets the spiritual tone for the message. Specific to the topic.

2. TITLE: A compelling, scripture-based title that captures the heart of the message. Give the central bible reading. For example, Hebrew 11:1-5

3. INTRODUCTION: A few introductory words to set the stage. Define the topic in simple, layman's terms so the congregation can understand even before you dive into the main points.

For example:
"Happy Sunday once again my people. This morning, we want to engage ourselves quickly in the Word of God. Our topic for today's sermon is 'Having Faith in Christ.' Firstly, what do we mean by faith? Faith is not just believing that God exists. Even the demons believe that. Faith is trusting God even when you cannot see the outcome..."

This section should help the congregation catch up before you start listing the points and illustrations.

4. SCRIPTURE READING: Minimum of 5 verses. Display them in full with references.

5. MAIN POINTS (4-7 points):
   For each point:
   - Point Title (scripture-backed)
   - Deep Explanation: Go beyond the surface. Explain the original context, meaning, and application.
   - Supporting Scriptures (2-3 verses per point)
   - Consequences (in two parts):
     - advantages: First, list what happens when you do this. Give clear, practical blessings. (3-4 points)
     - disadvantages: Then, transition with "On the contrary..." and list what happens when you don't do this. (3-4 points)

6. ILLUSTRATIONS / APPLICATIONS: Real-world stories, examples, or practical applications for 2 or 3 points. Make them relatable and memorable.

7. CONCLUSION: A strong, memorable summary that ties all the points together. Include a clear call to action. This should leave the listener challenged and encouraged.

8. CALL TO PRAYER / PRAYER POINTS: 3-5 specific prayer points that reinforce the message. These should be actionable prayer requests that the congregation can pray about during the week.

9. CLOSING PRAYER: A full closing prayer that sends the congregation out with a blessing and a challenge. This should be a complete prayer, not just a sentence.

STYLE:
- Warm and pastoral, not academic
- Deep and reflective, not shallow
- Accessible yet profound
- Use scripture naturally and meaningfully
- Aim for 4000-5500 words minimum for a full sermon

Return the response as a JSON object with the following keys:
openingPrayer, title, introduction, scriptureReading (an object with a "verses" array of {reference, text}), mainPoints (array of objects with title, explanation, supportingScriptures (array of {reference, text}), consequences (an object with "advantages" array and "disadvantages" array)), illustrations (array), conclusion, callToPrayer (array), closingPrayer.`;

  const userPrompt = `Topic: ${topic}\nScripture: ${scripture || 'None provided'}\n\nGenerate a complete, deep, reflective sermon using the structure above.`;

  const payload = JSON.stringify({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 6000,
    response_format: { type: 'json_object' }
  });

  try {
    const groqResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) reject(new Error(`Groq API error ${response.statusCode}: ${raw}`));
          else resolve(JSON.parse(raw));
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    const content = groqResponse.choices[0].message.content;
    const sermon = JSON.parse(content);

    // ====== INCREMENT USAGE COUNTER ======
    await userRef.update({
      generationsUsedThisMonth: admin.firestore.FieldValue.increment(1)
    });

    res.status(200).json(sermon);
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: 'Sermon generation failed: ' + err.message });
  }
};
