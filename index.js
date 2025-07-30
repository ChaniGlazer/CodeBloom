// server.js - גרסה תומכת ריבוי משתמשים + GET/POST עם תיעוד מלא

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

// אתחול של לקוחות ה־API
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

// אובייקט לניהול משתמשים פעילים - כל מספר טלפון שומר אינדקס ועצם מצב
const activeUsers = new Map();

// מערך לשמירת תוצאות אחרונות (תמלול + תשובה)
const results = [];

// פונקציית עזר לאתחול שמות קבצים (001, 002, ...)
function padNumber(num) {
  return num.toString().padStart(3, '0');
}

/**
 * ✅ פונקציה מאוחדת לטיפול גם ב־POST וגם ב־GET ב־/api/ym
 */
function handleYmRequest(phone, res, method = 'POST') {
  if (!phone) {
    console.log(`⚠️ לא התקבל מספר טלפון (${method})`);
    return res.json({});
  }

  if (!activeUsers.has(phone)) {
    activeUsers.set(phone, { index: 0, isProcessing: false });
    console.log(`📞 משתמש חדש (${method}): ${phone}`);
  } else {
    console.log(`📞 משתמש קיים (${method}): ${phone}`);
  }

  const response = { goto: '/5' }; // הנחיה לעבור לשלוחה 5
  console.log(`📤 מחזיר תגובה (${method}):`, response);
  res.json(response);
}

// תמיכה בקריאת POST מימות
app.post('/api/ym', (req, res) => {
  console.log('📥 POST התקבל מימות:', req.body);
  const phone = req.body.ApiPhone;
  handleYmRequest(phone, res, 'POST');
});

// תמיכה בקריאת GET מימות (למשל בעת בדיקות או שינויים עתידיים)
app.get('/api/ym', (req, res) => {
  console.log('📥 GET התקבל מימות:', req.query);
  const phone = req.query.ApiPhone;
  handleYmRequest(phone, res, 'GET');
});

/**
 * 🌀 לולאת עיבוד קבצים לכל משתמש פעיל - כל 500ms
 */
async function checkAndProcessNextFile() {
  for (const [phone, user] of activeUsers.entries()) {
    if (user.isProcessing) continue;

    const token = process.env.YEMOT_TOKEN;
    const fileName = padNumber(user.index) + '.wav';
    const yemotPath = `ivr2:/5/Phone/${phone}/${fileName}`;
    const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(yemotPath)}`;
    const uploadsDir = path.join(__dirname, 'uploads', phone);
    const localFilePath = path.join(uploadsDir, fileName);

    try {
      // יצירת תיקיית משתמש אם לא קיימת
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      user.isProcessing = true;

      // הורדת קובץ שמע מימות
      const response = await axios.get(downloadUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(localFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      console.log(`✅ קובץ ${fileName} הורד (${phone})`);

      // תמלול באמצעות OpenAI Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(localFilePath),
        model: 'whisper-1',
        language: 'he',
      });
      console.log(`🎤 תמלול (${phone}): ${transcription.text}`);

      // שליחת התמלול ל־GPT לעיבוד תשובה
      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'אתה עוזר דובר עברית למדעי המחשב ומחשבים בלבד. ישאלו אותך שאלות בתכנות ואתה תצטרך לענות ברור. נא למקד בתשובות ולטמצת, השאלות שישלחו אליך הם תמלול של קובץ שמע. לכן שים לב שיכול להיות שהתמלול לא תמלל נכון, ותנסה להבין מה הוא התכוון. על תענה לשאלות אחרות מלבד תכנות. התשובות שלך גם עוברות להיות הקראה של גוגל. לכן בתשובות שלך על תכלול דברים שא"א להגיד אותם. תן רק את הקוד עצמו, בלי הוספות. תמקד.',
          },
          { role: 'user', content: transcription.text }
        ]
      });
      const answer = chatResponse.choices[0].message.content;

      // יצירת קובצי שמע (MP3 + WAV)
      const baseName = padNumber(user.index);
      const mp3FileName = `${baseName}.mp3`;
      const wavFileName = `${baseName}.wav`;
      const mp3FilePath = path.join(uploadsDir, mp3FileName);
      const wavFilePath = path.join(uploadsDir, wavFileName);

      const [mp3Resp] = await ttsClient.synthesizeSpeech({
        input: { text: answer },
        voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MP3' },
      });
      await util.promisify(fs.writeFile)(mp3FilePath, mp3Resp.audioContent, 'binary');

      const [wavResp] = await ttsClient.synthesizeSpeech({
        input: { text: answer },
        voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'LINEAR16' },
      });
      await util.promisify(fs.writeFile)(wavFilePath, wavResp.audioContent, 'binary');
      console.log(`🔊 קבצי שמע נוצרו (${phone})`);

      // העלאת הקבצים חזרה לימות
      const mp3UploadPath = `ivr2:/5/Phone/${phone}/${mp3FileName}`;
      const mp3Form = new FormData();
      mp3Form.append('file', fs.createReadStream(mp3FilePath), { filename: mp3FileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(mp3UploadPath)}`, mp3Form, { headers: mp3Form.getHeaders() });

      const wavUploadPath = `ivr2:/5/Phone/${phone}/${wavFileName}`;
      const wavForm = new FormData();
      wavForm.append('file', fs.createReadStream(wavFilePath), { filename: wavFileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(wavUploadPath)}`, wavForm, { headers: wavForm.getHeaders() });

      console.log(`📤 קבצים הועלו (${phone})`);

      // שמירת התוצאה האחרונה בזיכרון
      results.push({ phone, index: baseName, transcription: transcription.text, answer });
      if (results.length > 100) results.shift();

      user.index++;

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`🔍 קובץ ${fileName} לא נמצא (${phone}), מנסה שוב...`);
      } else {
        console.error(`❌ שגיאה (${phone}):`, err.message);
      }
    } finally {
      user.isProcessing = false;
    }
  }
}

// קריאה חוזרת כל חצי שנייה
setInterval(checkAndProcessNextFile, 500);

// נקודת גישה לתוצאות
app.get('/results', (req, res) => {
  res.json(results);
});

// שורטקאט לבדיקה שהשרת חי
app.get('/', (req, res) => {
  res.send('✅ השרת פעיל');
});

// פינג עצמי כל 10 דקות
async function selfPing() {
  try {
    const url = process.env.SELF_PING_URL || `http://localhost:${port}/`;
    await axios.get(url);
  } catch (err) {
    console.error('❌ שגיאה בפינג:', err.message);
  }
}
setInterval(selfPing, 600000);

// הרצת השרת
app.listen(port, () => {
  console.log(`🚀 השרת פעיל על http://localhost:${port}`);
});
