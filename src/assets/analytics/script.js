fetch('/panel/analytics/data')
    .then(async (response) => {
        const data = await response.json();
        if (!data.success) throw new Error(data.message || 'failed');
        return data.body;
    })
    .then(({ usageStats, dailyUsage, sessionHistory }) => {
        const toGB = (bytes) => `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
        const text = (id, value) => document.getElementById(id).textContent = value;

        text('used', toGB(usageStats.usageBytes));
        text('remaining', usageStats.remainingBytes < 0 ? '∞' : toGB(usageStats.remainingBytes));
        text('days-left', usageStats.remainingDays < 0 ? '∞' : String(usageStats.remainingDays));
        text('active-users', `${usageStats.activeSessions} / ${usageStats.maxUsers || '∞'}`);

        const dailyTbody = document.getElementById('daily-usage');
        dailyUsage.forEach((item) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${item.date}</td><td>${(item.bytes / (1024 ** 3)).toFixed(3)}</td>`;
            dailyTbody.appendChild(tr);
        });

        const historyTbody = document.getElementById('session-history');
        sessionHistory.forEach((item) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${new Date(item.timestamp).toLocaleString()}</td>
                <td>${item.type}</td>
                <td>${item.userID}</td>
                <td>${item.sessionId}</td>
                <td>${item.bytes ?? '-'}</td>
                <td>${item.durationSec ?? '-'}</td>
                <td>${item.activeSessions ?? '-'}</td>
            `;
            historyTbody.appendChild(tr);
        });
    })
    .catch((error) => {
        alert(`Analytics load error: ${error.message || error}`);
    });
