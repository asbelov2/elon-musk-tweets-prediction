# Установка без Docker: Node.js и systemd

Для небольшой нагрузки можно начать с **1 vCPU и 1 ГБ RAM** на Ubuntu 24.04 LTS. Node.js запускается напрямую; systemd обеспечивает автозапуск и перезапуск после сбоя. По IP сайт обслуживает HTTP на порту 80, отдельный Nginx не нужен. Приложение уже проходит функциональную Docker-проверку с лимитами 1 CPU / 1 ГБ; предельная посещаемость этой проверкой не измеряется.

Это **новая установка с пустой базой**. Данные появятся после загрузки XTracker. Ниже команды выполняются по SSH под `root`.

## 1. Node.js 24 и исходники

```bash
apt-get update
apt-get install -y git curl ca-certificates gnupg
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
chmod 644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
node --version

git clone https://github.com/asbelov2/elon-musk-tweets-prediction.git /opt/tweetscope
cd /opt/tweetscope
```

Нужна Node.js **24.19 или новее в ветке 24**. Если репозиторий закрытый, используйте настроенный GitHub SSH deploy key. Если код уже клонирован в `/opt/tweetscope`, вместо повторного клонирования выполните там `git pull --ff-only`.

## 2. Swap для небольшого сервера

На VPS с 1 ГБ RAM полезен резерв на диске для сборки TypeScript. Следующий блок создаёт swap 1 ГБ **только при отсутствии активного swap и файла `/swapfile`**; существующий swap не меняет:

```bash
if [ -z "$(swapon --show=NAME --noheadings)" ] && [ ! -e /swapfile ]; then
  fallocate -l 1G /swapfile &&
  chmod 600 /swapfile &&
  mkswap /swapfile &&
  swapon /swapfile &&
  printf '\n/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
free -h
```

Swap даёт запас памяти, но не ускоряет расчёты. Файл создаётся на диске нового сервера.

## 3. Сборка, настройки и запуск

```bash
cd /opt/tweetscope
npm ci --include=dev --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=512 NODE_ENV=production npm run build

id tweetscope >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /var/lib/tweetscope --shell /usr/sbin/nologin tweetscope
read -r -p 'Публичный IP нового сервера: ' TWEETSCOPE_IP
install -m 600 /dev/null /etc/tweetscope.env
printf 'PUBLIC_URL=http://%s\nWRITE_ACCESS=public\n' "$TWEETSCOPE_IP" > /etc/tweetscope.env

install -m 644 deploy/tweetscope.service /etc/systemd/system/tweetscope.service
systemd-analyze verify /etc/systemd/system/tweetscope.service
systemctl daemon-reload
systemctl enable --now tweetscope
systemctl status tweetscope --no-pager
curl -fsS http://127.0.0.1/api/health
```

Блок настройки выше предназначен для новой установки: при последующих обновлениях не перезаписывайте `/etc/tweetscope.env`. Нативный сервис читает настройки из **`/etc/tweetscope.env`**, а не из `.env` рядом с кодом. Полный внешний адрес должен совпадать с браузером, например `PUBLIC_URL=http://195.133.15.110`. После изменения файла выполните `systemctl restart tweetscope`.

Все функции открыты всем, XTracker не требует токена X. Сервис работает от пользователя `tweetscope`; systemd даёт ему право слушать порт 80. История и каталог сохраняются в **`/var/lib/tweetscope/tweets.sqlite3`**, отдельно от кода. Каталог данных создаётся автоматически при старте сервиса.

В сетевом экране Timeweb разрешите входящий **TCP 80** и SSH. Откройте `http://НОВЫЙ_IP`, добавьте актуальное событие и нажмите «Загрузить историю», затем «Рассчитать прогноз».

Если на **этом же сервере** уже запущен Docker-вариант проекта, сначала освободите его порт командой из его папки: `docker compose -f compose.yaml -f compose.ip.yaml stop app`. Его том сохраняется; новая установка systemd использует отдельную пустую базу.

## Обновление

```bash
cd /opt/tweetscope
git pull --ff-only
npm ci --include=dev --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=512 NODE_ENV=production npm run build
systemctl restart tweetscope
systemctl status tweetscope --no-pager
```

История при обновлении кода сохраняется. На сервере с 1 ГБ RAM при нехватке памяти на сборку можно сначала остановить сервис командой `systemctl stop tweetscope` и запустить после сборки: `systemctl start tweetscope`.

## Журнал и резервная копия

```bash
journalctl -u tweetscope -n 100 --no-pager
runuser -u tweetscope -- env TWEET_DB=/var/lib/tweetscope/tweets.sqlite3 /usr/bin/node /opt/tweetscope/dist/scripts/backup.js
```

Согласованная копия создаётся в `/var/lib/tweetscope/backups/`. Обновление systemd-unit после изменения файла в репозитории: повторите `install -m 644 deploy/tweetscope.service /etc/systemd/system/tweetscope.service`, затем `systemctl daemon-reload` и `systemctl restart tweetscope`.
