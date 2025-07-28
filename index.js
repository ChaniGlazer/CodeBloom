// server.js - גרסה תומכת ריבוי משתמשים

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

// מפה של משתמשים פעילים
const activeUsers = new Map();
const results = [];

function padNumber(num) {
  return num.toString().padStart(3, '0');
}

// נקודת כניסה מימות
app.post('/api/ym', (req, res) => {
  console.log('📥 נתונים שהתקבלו מימות:', req.body);

  const phone = req.body.ApiPhone;
  if (!phone) {
    console.log('⚠️ לא התקבל מספר טלפון');
    return res.json({});
  }

  // אם המשתמש לא קיים עדיין
  if (!activeUsers.has(phone)) {
    activeUsers.set(phone, { index: 0, isProcessing: false });
    console.log(`📞 משתמש חדש: ${phone}`);
  } else {
    console.log(`📞 משתמש קיים: ${phone}`);
  }

  const response = { goto: '/5' }; // מעבר לשלוחה 5
  console.log('📤 מחזיר תגובה:', response);
  res.json(response);
});

// טיפול בקבצים לכל משתמש
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
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      user.isProcessing = true;
      const response = await axios.get(downloadUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(localFilePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log(`✅ קובץ ${fileName} הורד (${phone})`);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(localFilePath),
        model: 'whisper-1',
        language: 'he',
      });
      console.log(`🎤 תמלול (${phone}): ${transcription.text}`);

      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'אתה עוזר דובר עברית...' },
          { role: 'user', content: transcription.text }
        ]
      });
      const answer = chatResponse.choices[0].message.content;

      const baseName = padNumber(user.index);
      const mp3FileName = `${baseName}.mp3`;
      const wavFileName = `${baseName}.wav`;
      const mp3FilePath = path.join(uploadsDir, mp3FileName);
      const wavFilePath = path.join(uploadsDir, wavFileName);

      // יצירת MP3 ו־WAV
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

      const mp3UploadPath = `ivr2:/5/Phone/${phone}/${mp3FileName}`;
      const mp3Form = new FormData();
      mp3Form.append('file', fs.createReadStream(mp3FilePath), { filename: mp3FileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(mp3UploadPath)}`, mp3Form, { headers: mp3Form.getHeaders() });

      const wavUploadPath = `ivr2:/5/Phone/${phone}/${wavFileName}`;
      const wavForm = new FormData();
      wavForm.append('file', fs.createReadStream(wavFilePath), { filename: wavFileName });
      await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(wavUploadPath)}`, wavForm, { headers: wavForm.getHeaders() });

      console.log(`📤 קבצים הועלו (${phone})`);

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
setInterval(checkAndProcessNextFile, 1000);

app.get('/results', (req, res) => {
  res.json(results);
});

app.get('/', (req, res) => {
  res.send('✅ השרת פעיל');
});

// פינג עצמי
async function selfPing() {
  try {
    const url = process.env.SELF_PING_URL || `http://localhost:${port}/`;
    await axios.get(url);
  } catch (err) {
    console.error('❌ שגיאה בפינג:', err.message);
  }
}
setInterval(selfPing, 600000); // כל 10 דקות

app.listen(port, () => {
  console.log(`🚀 השרת פעיל על http://localhost:${port}`);
});
