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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

let fileIndex = 0;
let isProcessing = false;
const results = [];

function padNumber(num) {
  return num.toString().padStart(3, '0');
}

async function checkAndProcessNextFile() {
  if (isProcessing) return;
  isProcessing = true;

  const token = process.env.YEMOT_TOKEN || '0774430795:325916039';
  const fileName = padNumber(fileIndex) + '.wav';
  const phoneId = '0556784562' // להופיף לכאן קריאה מימות עם המספר טלפון
  const yemotPath = `ivr2:/5/Phone/${phoneId}/${fileName}`;
  const downloadUrl = `https://www.call2all.co.il/ym/api/DownloadFile?token=${token}&path=${encodeURIComponent(yemotPath)}`;
  const uploadsDir = path.join(__dirname, 'uploads');
  const localFilePath = path.join(uploadsDir, fileName);

  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
    }

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
      language: 'he', // הגדרת שפת התמלול כעברית
    });

    console.log(`🎤 תמלול: ${transcription.text}`);

    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `אתה עוזר דובר עברית, ענה בעברית בלבד, התשובות שלך צריכות להתאים לאמונה היהודית, תצא מנקודת הנחה שהמאזין שלך הוא יהודי מאמין מהעם היהודי ותענה תשובות מוחלטות בלי להוסיף שהתשובה היא לפי העם היהודי או לפי האמונה היהודית וכדומה, בלי מילים גסות וכדומה, תשובות קצרות, ברורות וממוקדות, שתואמות לאורח חיים חרדי ולטעם צנוע. 
          אם מתקבלת שאלה הלכתית או שאלת הלכה, אל תענה עליה בעצמך, אלא אמור: "אני לא רב ולא פוסק הלכה, נא לפנות לרב או לפוסק הלכה מוסמך."`
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
    const ttsRequestMP3 = {
      input: { text: answer },
      voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' },
    };
    const [mp3Response] = await ttsClient.synthesizeSpeech(ttsRequestMP3);
    await util.promisify(fs.writeFile)(mp3FilePath, mp3Response.audioContent, 'binary');

    // יצירת WAV
    const ttsRequestWAV = {
      input: { text: answer },
      voice: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'LINEAR16' },
    };
    const [wavResponse] = await ttsClient.synthesizeSpeech(ttsRequestWAV);
    await util.promisify(fs.writeFile)(wavFilePath, wavResponse.audioContent, 'binary');

    console.log(`🔊 קובצי שמע נוצרו: ${mp3FileName}, ${wavFileName}`);

    // שליחת MP3
    const mp3UploadPath = `ivr2:/5/Phone/${phoneId}/${mp3FileName}`;
    const mp3Url = `https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(mp3UploadPath)}`;
    const mp3Stream = fs.createReadStream(mp3FilePath);
    const mp3Form = new FormData();
    mp3Form.append('file', mp3Stream, { filename: mp3FileName });
    await axios.post(mp3Url, mp3Form, { headers: mp3Form.getHeaders() });
    console.log(`📤 נשלח MP3: ${mp3FileName}`);

    // שליחת WAV
    const wavUploadPath = `ivr2:/5/Phone/${phoneId}/${wavFileName}`; // לאותה שלוחה כדי שימות ישמיע לפי הצורך
    const wavUrl = `https://www.call2all.co.il/ym/api/UploadFile?token=${token}&path=${encodeURIComponent(wavUploadPath)}`;
    const wavStream = fs.createReadStream(wavFilePath);
    const wavForm = new FormData();
    wavForm.append('file', wavStream, { filename: wavFileName });
    await axios.post(wavUrl, wavForm, { headers: wavForm.getHeaders() });
    console.log(`📤 נשלח WAV: ${wavFileName}`);

    results.push({
      index: baseName,
      transcription: transcription.text,
      answer
    });

    if (results.length > 10) results.shift();
    fileIndex++;

  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.log(`🔍 קובץ ${fileName} לא נמצא, מנסה שוב...`);
    } else {
      console.error('❌ שגיאה:', err.message);
    }
  } finally {
    isProcessing = false;
  }
}

setInterval(checkAndProcessNextFile, 2000);

app.get('/results', (req, res) => {
  res.json(results);
});

app.get('/', (req, res) => {
  res.send('השרת פעיל');
});


app.listen(port, () => {
  console.log(`🚀 השרת רץ על http://localhost:${port}`);
});



async function selfPing() {
  try {
    const url = process.env.SELF_PING_URL || `http://localhost:${port}/`;
    console.log(`מבצע פינג עצמי לכתובת: ${url}`);
    await axios.get(url);
    console.log(`✅ פינג עצמי הצליח ל-${url}`);
  } catch (err) {
    console.error('❌ שגיאה בפינג עצמי:', err.message);
  }
}

// הפעלת הפינג העצמי כל דקה
setInterval(selfPing, 60 * 1000);

