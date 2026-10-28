export function startReferenceClocks() {
  const zones = { texas: 'America/Chicago', market: 'America/New_York', moscow: 'Europe/Moscow' };
  function update() {
    const now = new Date();
    for (const [name, timeZone] of Object.entries(zones)) {
      const clock = document.getElementById(`${name}-clock`) as HTMLTimeElement;
      clock.dateTime = now.toISOString();
      clock.textContent = new Intl.DateTimeFormat('ru-RU', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(now);
    }
    document.getElementById('texas-date')!.textContent = new Intl.DateTimeFormat('ru-RU', {
      timeZone: zones.texas,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(now);
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: zones.texas,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')!
      .value.replace('GMT', 'UTC');
    document.getElementById('texas-zone')!.textContent = `America/Chicago · ${offset}`;
  }
  update();
  setInterval(update, 1000);
}
