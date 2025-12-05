import {mlog,say} from './vendor/logs.js'
process.on('uncaughtException', (err) => {
mlog('Глобальный косяк приложения!!! ', err.stack);
}); //Если все пошло по ***, спасет ситуацию
import 'dotenv/config'

import bcrypt from 'bcrypt';
import * as db from './vendor/db.mjs';

import express from 'express'
import exphbs from 'express-handlebars'
import session from 'express-session'
import cookieParser from 'cookie-parser'
import path from 'path'
import fs from 'fs-extra'
import { fileURLToPath } from 'url';

var PORT = process.env.PORT || 789;
 //PORT = process.env.PORT || 80;
const app = express();
const hbs = exphbs.create({
defaultLayout: 'main',
extname: 'hbs',
helpers: {
    OK: function(){
    i_count = 1
    },
     // простой счётчик (если вдруг пригодится в списках)
    inc() {
        return i_count++;
    },
    reset() {
        i_count = 1;
        return '';
    },

    // взять подстроку: {{substr name 0 1}}
    substr(str, start, len) {
        str = (str ?? '').toString();
        const s = Number(start) || 0;
        const l = (len == null) ? undefined : Number(len);
        return str.substring(s, l ? s + l : undefined);
    },

    // поиск объекта по id в массиве: {{#with (findById types this.type)}}{{name}}{{/with}}
    findById(arr, id) {
        if (!Array.isArray(arr)) return null;
        const target = arr.find(x => String(x?.id) === String(id));
        return target || null;
    },

    // сравнения на всякий случай
    eq(a, b) { return String(a) === String(b); },
    ne(a, b) { return String(a) !== String(b); },
    gt(a, b) { return Number(a) > Number(b); },
    lt(a, b) { return Number(a) < Number(b); },

    // логика
    and() {
        const args = Array.from(arguments).slice(0, -1);
        return args.every(Boolean);
    },
    or() {
        const args = Array.from(arguments).slice(0, -1);
        return args.some(Boolean);
    },

    // отладка/быстрый вывод json
    json(ctx) {
        try { return JSON.stringify(ctx); } catch { return 'null'; }
    },
    I_C: function (opts){
    let anso = ''
    for (let i = 0; i < i_count; i++) {
        anso = anso + "I"
    }
    i_count++
    return anso
    },
    PLS: function (a,opts){

        return a+10
        },
    if_eq: function (a, b, opts) {
        if (a == b){ // Or === depending on your needs
           //  mlog(opts);
            return opts.fn(this);
        } else
            return opts.inverse(this);
    },
    if_more: function (a, b, opts) {
    if (a >= b){ // Or === depending on your needs
        // logman.log(opts);
        return opts.fn(this);
        } else
        return opts.inverse(this);
    },
    for: function(from, to, incr, block) {
        var accum = '';
        for(var i = from; i < to; i += incr)
            accum += block.fn(i);
        return accum;
    }
}
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export let appDir = __dirname;

app.engine('hbs', hbs.engine);
app.set('view engine', 'hbs');

const viewsPath = path.join(appDir, 'views');
const publicPath = path.join(appDir, 'public');

app.set('views', viewsPath);
mlog(publicPath);
app.use(express.static(publicPath));

app.use(cookieParser());
app.set('trust proxy', 1);

app.use(session({name: 'sso.sid',resave:true,saveUninitialized:false, secret: 'hardcode_secret_teyhd', cookie: 
  {secure: false, // ⚠️ обязательно false на HTTP!
  httpOnly: true}
}))
