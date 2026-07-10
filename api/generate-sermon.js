// api/generate-sermon.js
const https = require('https');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Firebase token
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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { topic, scripture } = body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return res.status(500).json({ error: 'GROQ_API_KEY missing' });

  const systemPrompt = `You are a seasoned pastor and theologian with deep knowledge of Scripture. You have been preaching and teaching for decades.

Your task is to generate a complete, deep, and reflective sermon that moves the heart and challenges the mind.

The sermon should be pastorally warm, theologically sound, and practically applicable. Avoid shallow clichés. Go deep.

STRUCTURE:

1. OPENING PRAYER: A prayer that sets the spiritual tone for the message. Specific to the topic.

2. TITLE: A compelling, scripture-based title that captures the heart of the message.

3. SCRIPTURE READING: Minimum of 5 verses. Display them in full with references.

4. MAIN POINTS (4-7 points):
   For each point:
   - Point Title (scripture-backed)
   - Deep Explanation: Go beyond the surface. Explain the original context, meaning, and application.
   - Supporting Scriptures (2-3 verses per point)
   - Consequences (where applicable):
     - If you do this: what happens
     - If you don't: what happens

5. ILLUSTRATIONS / APPLICATIONS: Real-world stories, examples, or practical applications for each point. Make them relatable and memorable.

6. CONCLUSION: A strong, memorable summary with a clear call to action. Should leave the listener challenged and encouraged.

7. CALL TO PRAYER: 3-5 specific prayer points that reinforce the message. These should be actionable prayer requests.

8. CLOSING PRAYER: A full closing prayer that sends the congregation out with a blessing and a challenge.

STYLE:
- Warm and pastoral, not academic
- Deep and reflective, not shallow
- Accessible yet profound
- Use scripture naturally and meaningfully
- Aim for 800-1200 words minimum for a full sermon

Return the response as a JSON object with the following keys:
openingPrayer, title, scriptureReading (an object with a "verses" array of {reference, text}), mainPoints (array of objects with title, explanation, supportingScriptures (array of {reference, text}), consequences (if applicable with ifDo and ifNot)), illustrations (array), conclusion, callToPrayer (array), closingPrayer.`;

  const userPrompt = `Topic: ${topic}\nScripture: ${scripture || 'None provided'}\n\nGenerate a complete, deep, reflective sermon using the structure above.`;

  const payload = JSON.stringify({
    model: 'openai/gpt-oss-120b', // 🔁 Updated to new GPT model
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 2500,
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
    res.status(200).json(sermon);
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: 'Sermon generation failed: ' + err.message });
  }
};
