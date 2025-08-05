// server.js - עיבוד קובץ אחד לכל קריאה מימות עם תיעוד מלא

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
require('dotenv').config();
const { OpenAI } = require('openai');
const FormData = require('form-data');
const util = require('util');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get("/api/ping", (req, res) => {
  res.send("pong");
});


// לקוחות של OpenAI ו-Google TTS
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

// ניהול משתמשים לפי מספר טלפון
const activeUsers = new Map();
const results = [];

// פונקציית עזר להמרת מספר לשלוש ספרות (001, 002, ...)
function padNumber(num) {
  return num.toString().padStart(3, '0');
}

/**
 * ✅ פונקציה לטיפול בקריאות GET/POST מימות
 * יוצרת משתמש חדש אם לא קיים, ומפעילה דגל shouldProcess = true
 */
function handleYmRequest(phone, res, method = 'POST') {
  if (!phone) {
    console.log(`⚠️ לא התקבל מספר טלפון (${method})`);
    return res.send(''); // שגיאה – החזר תגובה ריקה
  }

  if (!activeUsers.has(phone)) {
    activeUsers.set(phone, { index: 0, isProcessing: false, shouldProcess: true });
    console.log(`📞 משתמש חדש (${method}): ${phone}`);
  } else {
    const user = activeUsers.get(phone);
    user.shouldProcess = true; // בקשה חדשה מימות — יש לעבד קובץ
    console.log(`📞 משתמש קיים (${method}): ${phone}`);
  }

  const responseText = 'go_to_folder=/5'; // ✅ טקסט פשוט - בדיוק לפי ההוראות
  res.send(responseText);
  console.log(`📤 מחזיר תגובה (${method}):`, responseText);
}


// קלט POST
app.post('/api/ym', (req, res) => {
  console.log('📥 POST התקבל מימות:', req.body);
  const phone = req.body.ApiPhone;
  handleYmRequest(phone, res, 'POST');
});

// קלט GET
app.get('/api/ym', (req, res) => {
  console.log('📥 GET התקבל מימות:', req.query);
  const phone = req.query.ApiPhone;
  handleYmRequest(phone, res, 'GET');
});

/**
 * 🌀 לולאת עיבוד קבצים — מופעלת כל חצי שנייה, אך תעבד רק משתמשים שביקשו
 */
async function checkAndProcessNextFile() {
  for (const [phone, user] of activeUsers.entries()) {
    if (user.isProcessing || !user.shouldProcess) continue;

    user.isProcessing = true;
    user.shouldProcess = false; // נבצע רק עיבוד אחד עד הבקשה הבאה

    const token = process.env.YEMOT_TOKEN;
    const fileName = padNumber(user.index) + '.wav';
    const yemotPath = `ivr2:/5/Phone/${phone}/${fileName}`;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(yemotPath)}`;
    const uploadsDir = path.join(__dirname, 'uploads', phone);
    const localFilePath = path.join(uploadsDir, fileName);

    try {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      // הורדת הקובץ
      const response = await axios.get(downloadUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(localFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      console.log(`✅ קובץ ${fileName} הורד (${phone})`);

      // תמלול הקלט באמצעות Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(localFilePath),
        model: 'whisper-1',
        language: 'he',
      });
      console.log(`🎤 תמלול (${phone}): ${transcription.text}`);

      // יצירת תשובה על בסיס התמלול עם כללים מדויקים
      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `אתה עוזר דובר עברית לענייני מדעי המחשב בלבד.
השאלות שתקבל הן תוצאה של תמלול שמע. לעיתים יש שגיאות בתמלול — נסה להבין את כוונת הדובר.
ענה תשובה תמציתית, בעברית תקינה, ללא הקדמות, נימוסים או הסברים.
אין להשיב לשום דבר שאינו קשור לתכנות.
אין להשתמש במילים שאינן ניתנות להקראה קולית תקינה.
אין לכלול טקסטים לא שמישים בקול (למשל קישורים, מסמכים, HTML).
השב רק בקוד אם זו בקשה קוד, או משפט קצר אם זו שאלה כללית בתכנות.
שום דבר אחר לא יוקרא.`.trim()
          },
          { role: 'user', content: transcription.text }
        ]
      });
      const answer = chatResponse.choices[0].message.content;

      // שמות הקבצים
      const baseName = padNumber(user.index);
      const mp3FileName = `${baseName}.mp3`;
      const wavFileName = `${baseName}.wav`;
      const mp3FilePath = path.join(uploadsDir, mp3FileName);
      const wavFilePath = path.join(uploadsDir, wavFileName);

      // יצירת MP3
      const [mp3Resp] = await ttsClient.synthesizeSpeech({
        input: { text: answer },
        voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MP3' },
      });
      await util.promisify(fs.writeFile)(mp3FilePath, mp3Resp.audioContent, 'binary');

      // יצירת WAV
      const [wavResp] = await ttsClient.synthesizeSpeech({
        input: { text: answer },
        voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'LINEAR16' },
      });
      await util.promisify(fs.writeFile)(wavFilePath, wavResp.audioContent, 'binary');

      console.log(`🔊 קבצי שמע נוצרו (${phone})`);

      // העלאת הקבצים לימות
      const mp3UploadPath = `ivr2:/5/Phone/${phone}/${mp3FileName}`;
      const mp3Form = new FormData();
      mp3Form.append('file', fs.createReadStream(mp3FilePath), { filename: mp3FileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(mp3UploadPath)}`, mp3Form, { headers: mp3Form.getHeaders() });

      const wavUploadPath = `ivr2:/5/Phone/${phone}/${wavFileName}`;
      const wavForm = new FormData();
      wavForm.append('file', fs.createReadStream(wavFilePath), { filename: wavFileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(wavUploadPath)}`, wavForm, { headers: wavForm.getHeaders() });

      console.log(`📤 קבצים הועלו (${phone})`);

      // שמירת תוצאה
      results.push({ phone, index: baseName, transcription: transcription.text, answer });
      if (results.length > 100) results.shift();

      user.index++; // ✅ הגדלת אינדקס רק אחרי עיבוד מלא

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`🔍 קובץ ${fileName} לא נמצא (${phone})`);
      } else {
        console.error(`❌ שגיאה (${phone}):`, err.message);
      }
    } finally {
      user.isProcessing = false;
    }
  }
}

// הפעלת הבדיקה כל 500ms
setInterval(checkAndProcessNextFile, 500);

// תצוגת תוצאות
app.get('/results', (req, res) => {
  res.json(results);
});

// בדיקת חיים
app.get('/', (req, res) => {
  res.send('✅ השרת פעיל');
});

// פינג עצמי כל 10 דקות (למניעת שינה בהרצה בענן)
async function selfPing() {
  try {
    const url = process.env.SELF_PING_URL || `http://localhost:${port}/`;
    await axios.get(url);
  } catch (err) {
    console.error('❌ שגיאה בפינג:', err.message);
  }
}
setInterval(selfPing, 600000); // כל 10 דקות

// הרצת השרת
app.listen(port, () => {
  console.log(`🚀 השרת פעיל על http://localhost:${port}`);
});
