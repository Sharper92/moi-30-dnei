<?php
declare(strict_types=1);

use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

require __DIR__ . '/vendor/autoload.php';

$appConfigPath = dirname(__DIR__) . '/moi30-config.php';
$pushConfigPath = dirname(__DIR__) . '/moi30-push-config.php';
if (!is_file($appConfigPath) || !is_file($pushConfigPath)) {
    throw new RuntimeException('Push worker configuration is missing.');
}
$appConfig = require $appConfigPath;
$pushConfig = require $pushConfigPath;
$db = $appConfig['db'] ?? [];
$pdo = new PDO(
    sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $db['host'] ?? '', $db['name'] ?? ''),
    (string)($db['user'] ?? ''),
    (string)($db['password'] ?? ''),
    [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]
);
$pdo->exec("SET time_zone = '+00:00'");

if ((string)$pdo->query("SELECT GET_LOCK('moi30_push_worker', 0)")->fetchColumn() !== '1') {
    exit(0);
}

try {
    run_worker($pdo, $pushConfig);
} finally {
    $pdo->query("SELECT RELEASE_LOCK('moi30_push_worker')");
}

function run_worker(PDO $pdo, array $pushConfig): void
{
    foreach (['subject', 'publicKey', 'privateKey'] as $key) {
        if (!is_string($pushConfig[$key] ?? null) || $pushConfig[$key] === '') {
            throw new RuntimeException('Invalid VAPID configuration.');
        }
    }

    $settings = worker_push_settings($pdo);
    $users = $pdo->query(
        "SELECT DISTINCT u.id, u.last_seen_at, st.state
         FROM moi30_users u
         INNER JOIN moi30_push_subscriptions ps ON ps.user_id = u.id AND ps.enabled = 1
         INNER JOIN moi30_user_states st ON st.user_id = u.id
         WHERE u.must_change_password = 0"
    )->fetchAll();

    foreach ($users as $user) {
        try {
            process_user($pdo, $pushConfig, $settings, $user);
        } catch (Throwable $error) {
            error_log('Moi30 push failed for user ' . $user['id'] . ': ' . $error->getMessage());
        }
    }
}

function process_user(PDO $pdo, array $pushConfig, array $settings, array $user): void
{
    if (!is_string($user['last_seen_at'] ?? null) || $user['last_seen_at'] === '') {
        return;
    }
    $statement = $pdo->prepare(
        'SELECT id, endpoint, p256dh, auth_token, timezone, created_at
         FROM moi30_push_subscriptions WHERE user_id = ? AND enabled = 1'
    );
    $statement->execute([$user['id']]);
    $subscriptions = $statement->fetchAll();
    if ($subscriptions === []) {
        return;
    }

    $timezoneName = (string)$subscriptions[0]['timezone'];
    try {
        $timezone = new DateTimeZone($timezoneName);
    } catch (Throwable) {
        $timezone = new DateTimeZone('UTC');
    }
    $nowUtc = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $nowLocal = $nowUtc->setTimezone($timezone);
    $hour = (int)$nowLocal->format('G');
    if ($hour < 9 || $hour >= 21) {
        return;
    }

    $recent = $pdo->prepare(
        'SELECT COUNT(*) AS week_count, MAX(sent_at) AS last_sent,
                MAX(CASE WHEN kind = \'support\' THEN sent_at END) AS last_support
         FROM moi30_push_log WHERE user_id = ? AND sent_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)'
    );
    $recent->execute([$user['id']]);
    $delivery = $recent->fetch();
    if ((int)$delivery['week_count'] >= $settings['maxWeekly']) {
        return;
    }

    $lastSeen = new DateTimeImmutable($user['last_seen_at'], new DateTimeZone('UTC'));
    $state = json_decode((string)$user['state'], true);
    if (!is_array($state)) {
        return;
    }

    $kind = null;
    if ($settings['supportEnabled'] && $hour >= 18 && $hour < 20
        && $lastSeen <= $nowUtc->modify('-' . $settings['supportDelayHours'] . ' hours')
        && $lastSeen >= $nowUtc->modify('-24 hours')
        && has_marks_for_date($state, $nowLocal->format('Y-m-d'))
        && !was_sent_on_local_date($delivery['last_support'] ?? null, $nowLocal, $timezone)) {
        $kind = 'support';
    } elseif ($settings['inactiveEnabled'] && $hour >= 11 && $hour < 19
        && $lastSeen <= $nowUtc->modify('-' . $settings['inactivityDays'] . ' days')
        && oldest_subscription_is_ready($subscriptions, $nowUtc)
        && timestamp_is_older_than(
            $delivery['last_sent'] ?? null,
            $nowUtc->modify('-' . $settings['inactivityDays'] . ' days')
        )) {
        $kind = 'inactive';
    }
    if ($kind === null) {
        return;
    }

    $messages = notification_messages($kind);
    $message = $messages[random_int(0, count($messages) - 1)];
    $payload = json_encode([
        'title' => $message[0],
        'body' => $message[1],
        'tag' => 'moi30-' . $kind,
        'url' => '/index.html',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

    $webPush = new WebPush(['VAPID' => $pushConfig], [
        'TTL' => 43200,
        'urgency' => 'low',
        'topic' => 'moi30-' . $kind,
        'batchSize' => 50,
        'contentType' => 'application/json',
    ]);
    $webPush->setReuseVAPIDHeaders(true);
    foreach ($subscriptions as $subscription) {
        $webPush->queueNotification(Subscription::create([
            'endpoint' => $subscription['endpoint'],
            'keys' => ['p256dh' => $subscription['p256dh'], 'auth' => $subscription['auth_token']],
        ]), $payload);
    }

    $successful = 0;
    foreach ($webPush->flush() as $report) {
        if ($report->isSuccess()) {
            $successful++;
        } elseif ($report->isSubscriptionExpired()) {
            $delete = $pdo->prepare('DELETE FROM moi30_push_subscriptions WHERE endpoint_hash = ?');
            $delete->execute([hash('sha256', $report->getEndpoint())]);
        } else {
            error_log('Moi30 push delivery error: ' . $report->getReason());
        }
    }
    if ($successful > 0) {
        $log = $pdo->prepare(
            'INSERT INTO moi30_push_log (user_id, kind, successful_devices) VALUES (?, ?, ?)'
        );
        $log->execute([$user['id'], $kind, $successful]);
    }
}

function worker_push_settings(PDO $pdo): array
{
    $defaults = [
        'maxWeekly' => 3,
        'inactivityDays' => 3,
        'supportDelayHours' => 2,
        'supportEnabled' => true,
        'inactiveEnabled' => true,
    ];
    try {
        $value = $pdo->query(
            "SELECT setting_value FROM moi30_settings WHERE setting_key = 'push' LIMIT 1"
        )->fetchColumn();
        $settings = is_string($value) ? json_decode($value, true, 32, JSON_THROW_ON_ERROR) : null;
        if (!is_array($settings)) {
            return $defaults;
        }
        return [
            'maxWeekly' => max(1, min(7, (int)($settings['maxWeekly'] ?? 3))),
            'inactivityDays' => max(1, min(14, (int)($settings['inactivityDays'] ?? 3))),
            'supportDelayHours' => max(1, min(8, (int)($settings['supportDelayHours'] ?? 2))),
            'supportEnabled' => (bool)($settings['supportEnabled'] ?? true),
            'inactiveEnabled' => (bool)($settings['inactiveEnabled'] ?? true),
        ];
    } catch (Throwable) {
        return $defaults;
    }
}

function has_marks_for_date(array $state, string $date): bool
{
    $statuses = $state['entries'][$date]['statuses'] ?? null;
    if (!is_array($statuses)) {
        return false;
    }
    foreach ($statuses as $status) {
        if ($status === 'done' || $status === 'small') {
            return true;
        }
    }
    return false;
}

function was_sent_on_local_date(mixed $timestamp, DateTimeImmutable $nowLocal, DateTimeZone $timezone): bool
{
    if (!is_string($timestamp) || $timestamp === '') {
        return false;
    }
    $sent = new DateTimeImmutable($timestamp, new DateTimeZone('UTC'));
    return $sent->setTimezone($timezone)->format('Y-m-d') === $nowLocal->format('Y-m-d');
}

function oldest_subscription_is_ready(array $subscriptions, DateTimeImmutable $nowUtc): bool
{
    $oldest = null;
    foreach ($subscriptions as $subscription) {
        $created = new DateTimeImmutable($subscription['created_at'], new DateTimeZone('UTC'));
        $oldest = $oldest === null || $created < $oldest ? $created : $oldest;
    }
    return $oldest !== null && $oldest <= $nowUtc->modify('-24 hours');
}

function timestamp_is_older_than(mixed $timestamp, DateTimeImmutable $threshold): bool
{
    return !is_string($timestamp) || $timestamp === ''
        || new DateTimeImmutable($timestamp, new DateTimeZone('UTC')) <= $threshold;
}

function notification_messages(string $kind): array
{
    if ($kind === 'support') {
        return [
            ['Первый шаг уже сделан 🌱', 'Сегодня уже был шаг. Не обязательно делать идеально — продолжить можно бережно.'],
            ['Маленькое тоже считается ✨', 'Сегодня ты уже уделила время себе. Это настоящее движение вперёд.'],
            ['Твой рост уже идёт 🌿', 'Начатый день — уже победа. Если хочется, можно сделать ещё один спокойный шаг.'],
        ];
    }
    return [
        ['Можно просто вернуться 🌿', 'Пропуск ничего не отменяет. Открой трекер и выбери один посильный шаг.'],
        ['Твой прогресс на месте 💛', 'Не нужно начинать заново. Можно просто продолжить с одного посильного действия.'],
        ['Один шаг — уже достаточно ✨', 'Мы давно не виделись. Сегодня можно отметить даже самый маленький шаг.'],
    ];
}
