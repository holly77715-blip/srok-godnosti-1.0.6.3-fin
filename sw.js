// Кеширует страницу, чтобы она открывалась без интернета, и показывает
// уведомления о подходящих сроках годности.
// При обновлении файлов увеличьте номер версии ниже.
var CACHE = "srok-godnosti-v8";
var FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

// ---------- Уведомления о сроках ----------
var WARN_DAYS = 40;                          // начинаем напоминать за 40 дней
var REPEAT_MS = 3 * 3600 * 1000 - 5 * 60 * 1000;   // и повторяем каждые 3 часа (с запасом 5 минут)
var MAX_SINGLE = 5;                          // больше позиций за раз — одно общее уведомление
var DB_NAME = "srok-godnosti", DB_STORE = "kv";

function pad(n) { return (n < 10 ? "0" : "") + n; }
function fmt(dt) { return pad(dt.getDate()) + "." + pad(dt.getMonth() + 1) + "." + dt.getFullYear(); }
function plural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function parseISO(s) {
  var p = String(s || "").split("-");
  if (p.length !== 3) return null;
  var y = +p[0], m = +p[1], d = +p[2];
  if (!y || !m || !d) return null;
  var dt = new Date(y, m - 1, d);
  return (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) ? dt : null;
}
function addMonths(dt, months) {
  var target = new Date(dt.getFullYear(), dt.getMonth() + months, 1);
  var last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(dt.getDate(), last));
}
function daysLeft(end) {
  var n = new Date(), t = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((end.getTime() - t.getTime()) / 86400000);
}
function leftText(left) {
  if (left < 0) { var k = -left; return "просрочен на " + k + " " + plural(k, "день", "дня", "дней"); }
  if (left === 0) return "истекает сегодня";
  return "осталось " + left + " " + plural(left, "день", "дня", "дней");
}

function openDb() {
  return new Promise(function (resolve, reject) {
    var q = indexedDB.open(DB_NAME, 1);
    q.onupgradeneeded = function () { q.result.createObjectStore(DB_STORE); };
    q.onsuccess = function () { resolve(q.result); };
    q.onerror = function () { reject(q.error); };
  });
}
function kvGet(db, key) {
  return new Promise(function (resolve, reject) {
    var q = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    q.onsuccess = function () { resolve(q.result); };
    q.onerror = function () { reject(q.error); };
  });
}
function kvSet(db, key, val) {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function expiringItems(recs) {
  var out = [];
  (recs || []).forEach(function (r) {
    var made = parseISO(r.made);
    if (!made || typeof r.months !== "number") return;
    var end = addMonths(made, r.months), left = daysLeft(end);
    if (left <= WARN_DAYS) out.push({ id: r.id, note: r.note || "Без названия", end: end, left: left });
  });
  out.sort(function (a, b) { return a.left - b.left; });
  return out;
}

function showOne(it) {
  return self.registration.showNotification(it.left < 0 ? "Срок годности истёк" : "Срок годности подходит", {
    body: it.note + "\nГоден до " + fmt(it.end) + " — " + leftText(it.left),
    icon: "icon-192.png",
    tag: "exp-" + it.id,
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: "./index.html" }
  });
}
function showSummary(items) {
  var lines = items.slice(0, 5).map(function (it) {
    return it.note + " — " + leftText(it.left);
  });
  if (items.length > 5) lines.push("и ещё " + (items.length - 5));
  return self.registration.showNotification("Подходят сроки годности: " + items.length, {
    body: lines.join("\n"),
    icon: "icon-192.png",
    tag: "exp-summary",
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: "./index.html" }
  });
}

// Проверка: каждой позиции с остатком <= 40 дней уведомление не чаще раза в 3 часа
function checkAndNotify() {
  if (!self.Notification || Notification.permission !== "granted") return Promise.resolve();
  return openDb().then(function (db) {
    return Promise.all([kvGet(db, "records"), kvGet(db, "notified")]).then(function (res) {
      var items = expiringItems(res[0]), old = res[1] || {}, next = {}, now = Date.now(), due = [];
      items.forEach(function (it) {
        var last = old[it.id] || 0;
        if (now - last >= REPEAT_MS) { due.push(it); next[it.id] = now; }
        else next[it.id] = last;
      });
      var job = !due.length ? Promise.resolve()
        : (due.length <= MAX_SINGLE ? Promise.all(due.map(showOne)) : showSummary(due));
      return job.then(function () { return kvSet(db, "notified", next); });
    });
  }).catch(function () {});
}

// Проверки выполняются строго по очереди, чтобы не было дублей
var queue = Promise.resolve();
function enqueueCheck() {
  queue = queue.then(checkAndNotify, checkAndNotify);
  return queue;
}

self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "check") e.waitUntil(enqueueCheck());
});

// Фоновая проверка на Android (Chrome, установленное приложение)
self.addEventListener("periodicsync", function (e) {
  if (e.tag === "check-expiry") e.waitUntil(enqueueCheck());
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      return self.clients.openWindow("./index.html");
    })
  );
});

// ---------- Кеш ----------
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return resp;
      }).catch(function () { return caches.match("./index.html"); });
    })
  );
});
