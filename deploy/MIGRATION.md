# Перенос на другой VPS без потери истории

Для небольшой нагрузки достаточно начать с **1 vCPU и 2 ГБ RAM**. Runtime также проверяется в Docker с лимитами **1 CPU и 1 ГБ RAM**: эта проверка подтверждает работу приложения, но не измеряет предельную посещаемость. Сборке образа нужна дополнительная память; на VPS с 1 ГБ может потребоваться swap или сборка образа на другой машине. Отдельный сервер только ради второго ядра не требуется.

Ниже — перенос сайта, работающего по IP. В примерах старый проект находится в `~/tweetscope`; если вы клонировали его в другую папку, используйте её. На новом сервере сначала установите Git, Docker и Compose v2 по [основной инструкции](README.md#1-сервер). Подготовьте новый сервер до остановки старого.

## На старом сервере: остановка записей и согласованная копия

Эти команды запускайте из папки проекта. После остановки сайт на старом IP будет недоступен: так посетители не изменят базу после резервной копии.

```bash
cd ~/tweetscope
TRANSFER_FILE="tweetscope-transfer-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"
docker compose -f compose.yaml -f compose.ip.yaml stop app
docker compose -f compose.yaml -f compose.ip.yaml run --rm -T --no-deps --entrypoint node app dist/scripts/backup.js "/app/data/backups/$TRANSFER_FILE"
docker compose cp "app:/app/data/backups/$TRANSFER_FILE" "./$TRANSFER_FILE"
sha256sum "$TRANSFER_FILE"
```

Сохраните выведенную контрольную сумму. Копия содержит всю базу: историю всех аккаунтов, каталог, убранные события, счётчики и снимки рынка. Копировать отдельно работающий `tweets.sqlite3` нельзя: часть записей может находиться в WAL.

Передайте копию и настройки по SSH на **свой новый сервер**:

```bash
read -r -p 'IP нового сервера: ' NEW_SERVER_IP
scp "$TRANSFER_FILE" "root@$NEW_SERVER_IP:/root/tweetscope-transfer.sqlite3"
scp .env "root@$NEW_SERVER_IP:/root/tweetscope.env"
```

`.env` передаётся по SSH; содержимое и токены не нужно выводить в терминал или отправлять в чат.

## На новом сервере: код и новый IP

Команды ниже рассчитаны на новую установку без существующей базы и папки `~/tweetscope`:

```bash
cd ~
git clone https://github.com/asbelov2/elon-musk-tweets-prediction.git tweetscope
cd tweetscope
install -m 600 /root/tweetscope.env .env
read -r -p 'Публичный IP этого сервера: ' NEW_PUBLIC_IP
sed -i '/^PUBLIC_URL=/d' .env
printf '\nPUBLIC_URL=http://%s\n' "$NEW_PUBLIC_IP" >> .env
sha256sum /root/tweetscope-transfer.sqlite3
```

Сравните SHA-256 с суммой на старом сервере. Если совпадает, соберите образ и создайте контейнер с томом, **пока не запуская приложение**:

```bash
docker compose -f compose.yaml -f compose.ip.yaml build app
docker compose -f compose.yaml -f compose.ip.yaml create app
```

Восстановите копию. Проверка ниже откажется перезаписывать существующую базу или её WAL/SHM:

```bash
docker compose -f compose.yaml -f compose.ip.yaml run --rm -T --no-deps --entrypoint sh app -c '
set -eu
for file in /app/data/tweets.sqlite3 /app/data/tweets.sqlite3-wal /app/data/tweets.sqlite3-shm; do
  if [ -e "$file" ]; then
    echo "База уже существует: восстановление остановлено." >&2
    exit 1
  fi
done
umask 077
cat > /app/data/tweets.sqlite3
' < /root/tweetscope-transfer.sqlite3
```

После успешного восстановления:

```bash
docker compose -f compose.yaml -f compose.ip.yaml up -d
docker compose -f compose.yaml -f compose.ip.yaml ps
curl -fsS http://127.0.0.1/api/health
docker compose -f compose.yaml -f compose.ip.yaml logs --tail=50 app
```

Откройте `http://НОВЫЙ_IP`, проверьте список событий, количество часов истории и прогноз. При нестандартном HTTP-порте сохраните `TWEETSCOPE_PUBLIC_PORT` из `.env`, включите порт в `PUBLIC_URL` и используйте его в проверке `curl`. В сетевом экране нового сервера должны быть открыты HTTP-порт и SSH.

Старый сервер и его том оставьте до проверки нового. При необходимости вернуться на старый сервер запустите там `docker compose -f compose.yaml -f compose.ip.yaml up -d`. Дальнейшие изменения баз на двух серверах автоматически не объединяются.

Для домена с HTTPS переносится та же SQLite-копия, но используются `compose.https.yaml` и `APP_DOMAIN`, а DNS направляется на новый IP. Caddy на новом сервере выпустит сертификат заново.
