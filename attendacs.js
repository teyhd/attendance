import { mlog, say } from './vendor/logs.mjs'
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

let i_count = 1;
var PORT = process.env.PORT || 789;
const SESSION_SECRET = process.env.SESSION_SECRET || 'attendance-dev-session-secret';
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
},
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

app.use(session({name: 'sso.sid',resave:true,saveUninitialized:false, secret: SESSION_SECRET, cookie:
  {secure: false, // ⚠️ обязательно false на HTTP!
  httpOnly: true}
}))

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const classes = [
  { id: '1a', name: '1А' },
  { id: '1b', name: '1Б' },
  { id: '2a', name: '2А' }
];

const children = [
  { id: 'c1', name: 'Иван Иванов', classId: '1a' },
  { id: 'c2', name: 'Мария Петрова', classId: '1a' },
  { id: 'c3', name: 'Алексей Смирнов', classId: '1b' },
  { id: 'c4', name: 'София Кузнецова', classId: '2a' }
];

const absences = [];

const absenceReasons = [
  { id: 'illness', name: 'Болезнь' },
  { id: 'family', name: 'Семейные обстоятельства' },
  { id: 'trip', name: 'Поездка' },
  { id: 'other', name: 'Другое' }
];

app.get('/', (req, res) => {
  res.redirect('/attendance');
});

app.get('/attendance', (req, res) => {
  const selectedClass = req.query.class || classes[0]?.id;
  const classChildren = children.filter((c) => !selectedClass || String(c.classId) === String(selectedClass));
  const requestedStudent = req.query.student;
  const selectedChild = classChildren.find((c) => String(c.id) === String(requestedStudent)) || classChildren[0] || null;
  const selectedStudentId = selectedChild?.id || '';
  const now = new Date();

  const childrenView = classChildren.map((child) => ({
    ...child,
    hasAbsence: absences.some((a) => String(a.childId) === String(child.id)),
    isActive: selectedStudentId && String(selectedStudentId) === String(child.id),
  }));

  const childAbsences = absences
    .filter((item) => selectedStudentId && String(item.childId) === String(selectedStudentId))
    .map((item) => ({
      ...item,
      child: children.find((c) => String(c.id) === String(item.childId)) || null,
    }))
    .sort((a, b) => new Date(b.from) - new Date(a.from));

  const currentAbsences = childAbsences.filter((item) => {
    const from = new Date(item.from);
    const to = item.to ? new Date(item.to) : null;
    if (to) return to >= now;
    return from >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) || from <= now;
  });

  res.render('attendance', {
    title: 'Посещаемость',
    classes,
    children: childrenView,
    selectedChild,
    selectedStudentId,
    childAbsences,
    currentAbsences,
    selectedClass,
    reasons: absenceReasons,
    defaultFrom: new Date().toISOString().slice(0, 16),
    success: req.query.success,
  });
});

app.get('/attendance/:childId/new', (req, res) => {
  const { childId } = req.params;
  const selectedClass = req.query.class;
  const child = children.find((c) => String(c.id) === String(childId));
  if (!child) return res.status(404).send('Ребенок не найден');

  const redirectClass = selectedClass || child.classId;
  res.redirect(`/attendance?class=${encodeURIComponent(redirectClass)}&student=${encodeURIComponent(child.id)}`);
});

app.post('/attendance', (req, res) => {
  const { childId, from, to, reason, comment, classId } = req.body;
  const child = children.find((c) => String(c.id) === String(childId));

  if (!child) {
    return res.status(400).send('Неверный ребенок');
  }

  if (!from) {
    return res.status(400).send('Укажите время начала отсутствия');
  }

  const newAbsence = {
    id: Date.now().toString(),
    childId: child.id,
    from,
    to: to || '',
    reason: reason || 'other',
    comment: comment || '',
    createdAt: new Date().toISOString(),
  };

  absences.push(newAbsence);

  const redirectClass = classId || child.classId;
  res.redirect(`/attendance?class=${encodeURIComponent(redirectClass)}&student=${encodeURIComponent(child.id)}&success=1`);
});

app.listen(PORT, () => {
  mlog(`Приложение запущено на порту ${PORT}`);
});
