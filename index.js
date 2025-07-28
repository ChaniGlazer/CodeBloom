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

let fileIndex = 0;
let isProcessing = false;
let phoneId = ''; // יתעדכן מהקריאה של ימות
const results = [];

function padNumber(num) {
  return num.toString().padStart(3, '0');
}

// קבלת מספר טלפון מהשלוחה והעברת המתקשר לשלוחה 5
app.post('/api/ym', (req, res) => {
  console.log('📥 נתונים שהתקבלו מימות:', req.body); // לוג חשוב

  const phone = req.body.ApiPhone || '';
  if (phone) {
    phoneId = phone;
    console.log(`📞 מספר זוהה: ${phone}`);
  } else {
    console.log('⚠️ לא התקבל מספר טלפון');
  }

  const response = { goto: '/5' };
  console.log('📤 מחזיר תגובה:', response);
  res.json(response);
});


async function checkAndProcessNextFile() {
  if (isProcessing || !phoneId) return;
  isProcessing = true;

  const token = process.env.YEMOT_TOKEN || '0774430795:325916039';
  const fileName = padNumber(fileIndex) + '.wav';
  const yemotPath = `ivr2:/5/Phone/${phoneId}/${fileName}`;
  const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(yemotPath)}`;
  const uploadsDir = path.join(__dirname, 'uploads');
  const localFilePath = path.join(uploadsDir, fileName);

  try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    const response = await axios.get(downloadUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(localFilePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log(`✅ קובץ ${fileName} הורד`);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(localFilePath),
      model: 'whisper-1',
      language: 'he',
    });

    console.log(`🎤 תמלול: ${transcription.text}`);

    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `אתה עוזר דובר עברית...`
        },
        { role: 'user', content: transcription.text }
      ]
    });

    const answer = chatResponse.choices[0].message.content;

    const baseName = padNumber(fileIndex);
    const mp3FileName = `${baseName}.mp3`;
    const wavFileName = `${baseName}.wav`;
    const mp3FilePath = path.join(uploadsDir, mp3FileName);
    const wavFilePath = path.join(uploadsDir, wavFileName);

    // יצירת MP3
    const [mp3Response] = await ttsClient.synthesizeSpeech({
      input: { text: answer },
      voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    await util.promisify(fs.writeFile)(mp3FilePath, mp3Response.audioContent, 'binary');

    // יצירת WAV
    const [wavResponse] = await ttsClient.synthesizeSpeech({
      input: { text: answer },
      voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'LINEAR16' },
    });
    await util.promisify(fs.writeFile)(wavFilePath, wavResponse.audioContent, 'binary');

    console.log(`🔊 קובצי שמע נוצרו: ${mp3FileName}, ${wavFileName}`);

    // שליחת קבצים
    const mp3UploadPath = `ivr2:/5/Phone/${phoneId}/${mp3FileName}`;
    const mp3Stream = fs.createReadStream(mp3FilePath);
    const mp3Form = new FormData();
    mp3Form.append('file', mp3Stream, { filename: mp3FileName });
    await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(mp3UploadPath)}`, mp3Form, { headers: mp3Form.getHeaders() });

    const wavUploadPath = `ivr2:/5/Phone/${phoneId}/${wavFileName}`;
    const wavStream = fs.createReadStream(wavFilePath);
    const wavForm = new FormData();
    wavForm.append('file', wavStream, { filename: wavFileName });
    await axios.post(`https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(wavUploadPath)}`, wavForm, { headers: wavForm.getHeaders() });

    console.log(`📤 קבצים הועלו לשלוחה`);

    results.push({ index: baseName, transcription: transcription.text, answer });
    if (results.length > 10) results.shift();
    fileIndex++;

  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`🔍 קובץ ${fileName} לא נמצא, מנסה שוב...`);
    } else {
      console.error('❌ שגיאה:', err.message);
    }
  } finally {
    isProcessing = false;
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
setInterval(selfPing, 60 * 10000);

app.listen(port, () => {
  console.log(`🚀 השרת פעיל על http://localhost:${port}`);
});
