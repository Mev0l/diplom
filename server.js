const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path`');
const session = require('express-session');
const app = express();
const QRCode = require('qrcode');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const B24_WEBHOOK = "https://b24-c15sq2.bitrix24.ru/rest/1/2xyexpag7xovn0gr/";

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'barbersecret',
  resave: false,
  saveUninitialized: true
}));

// ========== Клиентская часть (запись) ==========

// Получить занятые слоты на день
app.get('/api/busy-slots', async (req, res) => {
  const { day } = req.query;
  try {
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.list.json`, {
      filter: {
        ">DATE_CREATE": `${day}T00:00:00+03:00`,
        "<DATE_CREATE": `${day}T23:59:59+03:00`,
        "STATUS_ID": ["NEW", "IN_PROCESS", "APPOINTED", "CONFIRMED"],
      },
      select: ["ID", "COMMENTS"]
    });
    const busySlots = [];
    for (const lead of resp.data.result) {
      const comment = lead.COMMENTS || '';
      const m = comment.match(/Услуга: (.*), Дата: ([\d-]+), Время: (\d{2}:\d{2}), Длительность: (\d+) мин/);
      if (m) {
        busySlots.push({
          service: m[1],
          day: m[2],
          time: m[3],
          duration: parseInt(m[4])
        });
      }
    }
    res.json(busySlots);
  } catch (err) {
    res.status(500).json({error: err.toString()});
  }
});
app.get('/qr/client', async (req, res) => {
  try {
    const target = 'https://diplom-production-78a7.up.railway.app/';
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    console.error('QR/client error:', err);
    res.status(500).send('Ошибка генерации QR для клиентской части');
  }
});

// QR-код для админки
app.get('/qr/admin', async (req, res) => {
  try {
    // Если у вас админка открывается не с корня, а, например, с /admin.html — поправьте URL ниже
    const target = 'https://diplom-production-78a7.up.railway.app/admin.html';
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    console.error('QR/admin error:', err);
    res.status(500).send('Ошибка генерации QR для админки');
  }
});
// Новая заявка (создать лид в Bitrix24)
app.post('/api/book', async (req, res) => {
  const { name, phone, service, day, time, duration, price } = req.body;
  try {
    // 1. Создаём лид с ценой и подробностями
    const data = {
      fields: {
        TITLE: "Онлайн-запись в Барбершоп",
        NAME: name,
        PHONE: [{VALUE: phone, VALUE_TYPE: "WORK"}],
        COMMENTS: `Услуга: ${service}, Дата: ${day}, Время: ${time}, Длительность: ${duration} мин.`,
        SOURCE_ID: "WEB",
        STATUS_ID: "NEW",
        OPPORTUNITY: price // записываем цену
      }
    };
    const leadResp = await axios.post(`${B24_WEBHOOK}crm.lead.add.json`, data);
    const leadId = leadResp.data.result;
    if (leadId) {
      // 2. Добавляем товарную позицию к лиду
      await axios.post(`${B24_WEBHOOK}crm.lead.productrows.set.json`, {
        id: leadId,
        rows: [{
          PRODUCT_NAME: service,
          PRICE: price,
          QUANTITY: 1
        }]
      });
      res.json({ok: true});
    } else {
      res.json({ok: false, error: leadResp.data});
    }
  } catch (err) {
    res.status(500).json({error: err.toString()});
  }
  
});

// ========== Админ-панель ==========

// Вход для админа
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {
    req.session.admin = true;
    res.json({ok: true});
  } else {
    res.json({ok: false, error: "Неверный пароль"});
  }
});
function isAdmin(req, res, next) {
  if (req.session && req.session.admin) next();
  else res.status(401).json({error: 'Нет доступа'});
}

// Получить все записи для календаря (c OPPORTUNITY)
app.get('/admin/records', isAdmin, async (req, res) => {
  const from = new Date(); from.setDate(from.getDate() - 1);
  const to = new Date(); to.setDate(to.getDate() + 3);
  const filter = {
    '>DATE_CREATE': from.toISOString().slice(0,10)+'T00:00:00+03:00',
    '<DATE_CREATE': to.toISOString().slice(0,10)+'T23:59:59+03:00',
  };
  try {
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.list.json`, {
      filter,
      select: ["ID", "NAME", "COMMENTS", "STATUS_ID", "OPPORTUNITY"]
    });
    const records = resp.data.result.map(lead => {
      const m = (lead.COMMENTS || '').match(/Услуга: (.*), Дата: ([\d-]+), Время: (\d{2}:\d{2}), Длительность: (\d+) мин/);
      return m ? {
        id: lead.ID,
        name: lead.NAME,
        service: m[1],
        day: m[2],
        time: m[3],
        duration: parseInt(m[4]),
        status: lead.STATUS_ID,
        price: lead.OPPORTUNITY // теперь сумма
      } : null;
    }).filter(Boolean);
    res.json(records);
  } catch (e) {
    res.status(500).json({error: e.toString()});
  }
});

// Смена статуса клиента
app.post('/admin/update-status', isAdmin, async (req, res) => {
  const { id, status } = req.body;
  try {
    await axios.post(`${B24_WEBHOOK}crm.lead.update.json`, {
      id,
      fields: { STATUS_ID: status }
    });
    res.json({ok: true});
  } catch (e) {
    res.status(500).json({error: e.toString()});
  }
});
// Итоги по записям за сегодня
app.get('/admin/today-totals', isAdmin, async (req, res) => {
  const today = new Date();
  const dayStr = today.toISOString().slice(0, 10);
  const filter = {
    '>DATE_CREATE': `${dayStr}T00:00:00+03:00`,
    '<DATE_CREATE': `${dayStr}T23:59:59+03:00`,
  };

  try {
    // Достаём все лиды за сегодня с нужными полями
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.list.json`, {
      filter,
      select: ["ID", "COMMENTS", "OPPORTUNITY", "UF_PAYMENT_TYPE", "UF_DISCOUNT"]
    });

    let total = 0, cash = 0, card = 0, discount = 0;

    for (const lead of resp.data.result) {
      // Сумма
      const price = Number(lead.OPPORTUNITY) || 0;
      total += price;

      // Оплата — из кастомного поля UF_PAYMENT_TYPE или из COMMENTS
      let payment = lead.UF_PAYMENT_TYPE || "";
      if (!payment && lead.COMMENTS) {
        if (/оплата: *наличн/i.test(lead.COMMENTS)) payment = "cash";
        if (/оплата: *карт/i.test(lead.COMMENTS)) payment = "card";
      }
      if (payment === "cash") cash += price;
      if (payment === "card") card += price;

      // Скидка — из кастомного поля UF_DISCOUNT или из COMMENTS
      let disc = Number(lead.UF_DISCOUNT) || 0;
      if (!disc && lead.COMMENTS) {
        let m = lead.COMMENTS.match(/Скидка: *(\d+)/i);
        if (m) disc = Number(m[1]);
      }
      discount += disc;
    }

    res.json({ total, cash, card, discount });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});
// Новый API endpoint для создания события в календаре Bitrix24
app.post('/api/create-calendar-event', async (req, res) => {
  const { name, phone, service, day, time, duration, price } = req.body;
  try {
    // start/end в формате YYYY-MM-DDTHH:MM:SS
    const start = `${day}T${time}:00+03:00`;
    // Вычислить end (по длительности)
    let [h, m] = time.split(':').map(Number);
    let endDate = new Date(`${day}T${time}:00+03:00`);
    endDate.setMinutes(endDate.getMinutes() + parseInt(duration));
    const end = endDate.toISOString().slice(0, 19) + "+03:00";

    const event = {
      fields: {
        NAME: `${service} (${name})`,
        DESCRIPTION: `Телефон: ${phone}, Цена: ${price}`,
        DATE_FROM: start,
        DATE_TO: end,
        SECTION: 1 // id календаря (обычно 1 — календарь администратора)
      }
    };
    const resp = await axios.post(
      B24_WEBHOOK + 'calendar.event.add.json',
      event
    );
    res.json({ ok: true, result: resp.data.result });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});
// Получить все комментарии по лидам за последние 4 дня
app.get('/admin/all-comments', isAdmin, async (req, res) => {
  const from = new Date();
  from.setDate(from.getDate() - 4);
  const filter = {
    '>DATE_CREATE': from.toISOString().slice(0,10) + 'T00:00:00+03:00'
  };

  try {
    // 1. Получаем все лиды за период
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.list.json`, {
      filter,
      select: ["ID", "NAME", "PHONE"]
    });
    const leads = resp.data.result || [];
    let allComments = [];

    // 2. Для каждого лида получаем его комментарии из crm.timeline.comment.list
    for (const lead of leads) {
      // Bitrix24 требует ENTITY_TYPE: 'lead', ENTITY_ID: <lead.ID>
      const timelineResp = await axios.post(`${B24_WEBHOOK}crm.timeline.comment.list.json`, {
        filter: { ENTITY_TYPE: 'lead', ENTITY_ID: lead.ID }
      });
      const comments = (timelineResp.data.result || []).map(c => ({
        leadId: lead.ID,
        name: lead.NAME,
        phone: lead.PHONE && lead.PHONE[0] ? lead.PHONE[0].VALUE : "",
        comment: c.COMMENT,
        created: c.CREATED
      }));
      allComments.push(...comments);
    }

    // Сортируем по дате (свежие сверху)
    allComments.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    res.json(allComments);

  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post('/admin/update-price', isAdmin, async (req, res) => {
  const { id, price } = req.body;
  let num = Number(price);
  if (isNaN(num)) num = 0;
  console.log('update-price', { id, price, num }); // ДЛЯ ДЕБАГА
  try {
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.update.json`, {
      id,
      fields: { OPPORTUNITY: num }
    });
    console.log('Bitrix resp:', resp.data); // ДЛЯ ДЕБАГА
    res.json({ok: true});
  } catch (e) {
    console.log('ERROR:', e.response?.data || e.toString());
    res.status(500).json({error: e.toString()});
  }
});
// Удаление лида по ID (для админки)
app.post('/admin/delete', isAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    await axios.post(`${B24_WEBHOOK}crm.lead.delete.json`, { id });
    res.json({ok: true});
  } catch (e) {
    res.status(500).json({error: e.toString()});
  }
});
app.post('/admin/move-record', isAdmin, async (req, res) => {
  const { id, newDay, newTime } = req.body;
  try {
    const resp = await axios.post(`${B24_WEBHOOK}crm.lead.get.json`, { id });
    const lead = resp.data.result;
    let comments = lead.COMMENTS || '';
    comments = comments.replace(/Дата: [\d-]+/, `Дата: ${newDay}`);
    comments = comments.replace(/Время: \d{2}:\d{2}/, `Время: ${newTime}`);
    await axios.post(`${B24_WEBHOOK}crm.lead.update.json`, {
      id,
      fields: { COMMENTS: comments }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});
app.get('/qr', async (req, res) => {
  // Замените на свой реальный домен после деплоя!
  const publicURL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  try {
    const svg = await QRCode.toString(publicURL, { type: 'svg', margin: 1 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send('QR generation error');
  }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Server started on port", PORT));
