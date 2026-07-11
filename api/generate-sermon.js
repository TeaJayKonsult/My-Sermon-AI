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

   Example consequence structure:
   "consequences": {
     "advantages": [
       "Advantage 1: When you place your trust in God, you experience peace that surpasses all understanding.",
       "Advantage 2: You receive divine guidance and direction for your life.",
       "Advantage 3: Your faith becomes a testimony to others.",
       "Advantage 4: You are protected and provided for by God."
     ],
     "disadvantages": [
       "Consequence 1: Without trust in God, you live in constant anxiety and fear.",
       "Consequence 2: You miss out on God's best for your life.",
       "Consequence 3: Your lack of faith hinders your relationship with God.",
       "Consequence 4: You become easily shaken by life's storms."
     ]
   }

6. ILLUSTRATIONS / APPLICATIONS: Real-world stories, examples, or practical applications for each point. Make them relatable and memorable.

7. CONCLUSION: A strong, memorable summary that ties all the points together. Include a clear call to action. This should leave the listener challenged and encouraged.

8. CALL TO PRAYER / PRAYER POINTS: 3-5 specific prayer points that reinforce the message. These should be actionable prayer requests that the congregation can pray about during the week. For example: "Pray for the faith to trust God even when you cannot see the outcome", "Pray for strength to obey God's Word even when it's difficult."

9. CLOSING PRAYER: A full closing prayer that sends the congregation out with a blessing and a challenge. This should be a complete prayer, not just a sentence.

STYLE:
- Warm and pastoral, not academic
- Deep and reflective, not shallow
- Accessible yet profound
- Use scripture naturally and meaningfully
- Aim for 800-1200 words minimum for a full sermon

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
