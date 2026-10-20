<?php
declare(strict_types=1);

use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

function moi30_send_manual_push(
    PDO $pdo,
    array $pushConfig,
    array $userIds,
    string $title,
    string $message
): array {
    $userIds = array_values(array_unique(array_filter($userIds, 'is_string')));
    if ($userIds === []) {
        return ['targetedUsers' => 0, 'successfulUsers' => 0, 'successfulDevices' => 0, 'failedDevices' => 0];
    }

    $placeholders = implode(',', array_fill(0, count($userIds), '?'));
    $statement = $pdo->prepare(
        "SELECT user_id, endpoint, p256dh, auth_token
         FROM moi30_push_subscriptions
         WHERE enabled = 1 AND user_id IN ($placeholders)"
    );
    $statement->execute($userIds);
    $subscriptions = $statement->fetchAll();
    if ($subscriptions === []) {
        return [
            'targetedUsers' => count($userIds), 'successfulUsers' => 0,
            'successfulDevices' => 0, 'failedDevices' => 0,
        ];
    }

    $payload = json_encode([
        'title' => $title,
        'body' => $message,
        'tag' => 'moi30-admin-message',
        'url' => '/index.html',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

    $webPush = new WebPush(['VAPID' => $pushConfig], [
        'TTL' => 43200,
        'urgency' => 'normal',
        'topic' => 'moi30-admin-message',
        'batchSize' => 100,
        'contentType' => 'application/json',
    ]);
    $webPush->setReuseVAPIDHeaders(true);
    $endpointUsers = [];
    foreach ($subscriptions as $subscription) {
        $endpointUsers[hash('sha256', $subscription['endpoint'])] = $subscription['user_id'];
        $webPush->queueNotification(Subscription::create([
            'endpoint' => $subscription['endpoint'],
            'keys' => ['p256dh' => $subscription['p256dh'], 'auth' => $subscription['auth_token']],
        ]), $payload);
    }

    $successfulDevices = 0;
    $failedDevices = 0;
    $successfulUsers = [];
    foreach ($webPush->flush() as $report) {
        $endpoint = $report->getEndpoint();
        $endpointHash = hash('sha256', $endpoint);
        if ($report->isSuccess()) {
            $successfulDevices++;
            if (isset($endpointUsers[$endpointHash])) {
                $userId = $endpointUsers[$endpointHash];
                $successfulUsers[$userId] = ($successfulUsers[$userId] ?? 0) + 1;
            }
        } else {
            $failedDevices++;
            if ($report->isSubscriptionExpired()) {
                $delete = $pdo->prepare('DELETE FROM moi30_push_subscriptions WHERE endpoint_hash = ?');
                $delete->execute([$endpointHash]);
            }
            error_log('Moi30 manual push delivery error: ' . $report->getReason());
        }
    }

    if ($successfulUsers !== []) {
        $log = $pdo->prepare(
            "INSERT INTO moi30_push_log (user_id, kind, successful_devices) VALUES (?, 'manual', ?)"
        );
        foreach ($successfulUsers as $userId => $devices) {
            $log->execute([$userId, $devices]);
        }
    }

    return [
        'targetedUsers' => count($userIds),
        'successfulUsers' => count($successfulUsers),
        'successfulDevices' => $successfulDevices,
        'failedDevices' => $failedDevices,
    ];
}
