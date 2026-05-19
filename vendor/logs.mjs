import fs from 'fs-extra'
import path from 'path'

import { fileURLToPath } from 'url';

// Получаем __dirname в ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export let appDir = __dirname;

function curdate(minute){
    minute = (minute < 10) ? '0' + minute : minute;
    return minute;
  }
  
export function mlog (par) {
    let datecreate = new Date();
    let texta = `\n ${curdate(datecreate.getHours())}:${curdate(datecreate.getMinutes())}:${curdate(datecreate.getSeconds())}`;
    let obj = arguments;
    const logsDir = path.join(appDir, 'logs');
    const logName = `${curdate(datecreate.getDate())}.${curdate(datecreate.getMonth()+1)}.${String(datecreate.getFullYear()).slice(-2)}.txt`;
  
    for (const key in obj) {
      if (typeof obj[key]=='object') {
        for (const keys in obj[key]){
          texta = `${texta} \n ${keys}:${obj[key][keys]}`
        }
      } else {
        texta = `${texta} ${obj[key]}`
      }
      
    } 
    try {
      fs.ensureDirSync(logsDir);
      fs.appendFileSync(path.join(logsDir, logName), texta, { encoding: "utf8" });
    } catch (err) {
      console.error('Не удалось записать runtime-лог:', err?.message || err);
    }
  
    console.log(texta);
    return texta
  }

export function say(msg,all=true) {
  var numb = ['79176334420']
  var tgnum = [304622290,5662630619]
  if (all===true){
    tgnum.forEach(element => {
      setTimeout(() => sendtg(element,msg), 1500);
    });
  } else{
    setTimeout(() => sendtg(tgnum[0],msg), 1500);
  }
  
}

function sendtg(num,msg) {
    const url = new URL('http://home.teyhd.ru:3334/');
    url.searchParams.set('msg', msg);
    url.searchParams.set('num', num);
    fetch(url).catch(() => {});
}


