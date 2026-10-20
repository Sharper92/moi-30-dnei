<?php
declare(strict_types=1);

const COOKIE_NAME = 'moi30_session';
const MAX_BODY_BYTES = 524288;
const GROUPS = ['Забота о себе', 'Уход', 'Духовная практика', 'Дом и развитие'];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");

$configPath = dirname(__DIR__, 3) . '/moi30-config.php';
if (!is_file($configPath)) {
    error_log('Moi30 configuration file is missing: ' . $configPath);
    respond(500, ['error' => 'SERVER_ERROR']);
}

$config = require $configPath;
if (!is_array($config)) {
    error_log('Moi30 configuration file must return an array.');
    respond(500, ['error' => 'SERVER_ERROR']);
}

$pushConfigPath = dirname(__DIR__, 3) . '/moi30-push-config.php';
$config['push'] = is_file($pushConfigPath) ? require $pushConfigPath : [];
if (!is_array($config['push'])) {
    $config['push'] = [];
}

date_default_timezone_set((string)($config['timezone'] ?? 'UTC'));

if (PHP_SAPI !== 'cli' && !request_is_https()) {
    $host = preg_replace('/[^A-Za-z0-9.:-]/', '', (string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '') {
        respond(400, ['error' => 'INVALID_REQUEST']);
    }
    header('Location: https://' . $host . ($_SERVER['REQUEST_URI'] ?? '/'), true, 308);
    exit;
}

try {
    $pdo = connect_database($config);
    migrate_and_seed($pdo, $config);
    route_request($pdo, $config);
} catch (Throwable $error) {
    error_log((string)$error);
    respond(500, ['error' => 'SERVER_ERROR']);
}

function connect_database(array $config): PDO
{
    $db = $config['db'] ?? [];
    foreach (['host', 'name', 'user', 'password'] as $key) {
        if (!isset($db[$key]) || !is_string($db[$key])) {
            throw new RuntimeException('Missing database configuration: ' . $key);
        }
    }

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=utf8mb4',
        $db['host'],
        $db['name']
    );
    $pdo = new PDO($dsn, $db['user'], $db['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}

function migrate_and_seed(PDO $pdo, array $config): void
{
    $statements = [
        "CREATE TABLE IF NOT EXISTS moi30_users (
            id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
            username VARCHAR(32) NOT NULL,
            username_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
            password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
            must_change_password TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS moi30_user_states (
            user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
            state JSON NOT NULL,
            revision INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT moi30_states_user_fk FOREIGN KEY (user_id) REFERENCES moi30_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS moi30_sessions (
            token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
            user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX moi30_sessions_user_idx (user_id),
            INDEX moi30_sessions_expiry_idx (expires_at),
            CONSTRAINT moi30_sessions_user_fk FOREIGN KEY (user_id) REFERENCES moi30_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS moi30_rate_limits (
            key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
            window_started DATETIME NOT NULL,
            hits INT UNSIGNED NOT NULL DEFAULT 1
        ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin",
        "CREATE TABLE IF NOT EXISTS moi30_push_subscriptions (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
            endpoint TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            p256dh VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            auth_token VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'UTC',
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX moi30_push_user_idx (user_id),
            CONSTRAINT moi30_push_user_fk FOREIGN KEY (user_id) REFERENCES moi30_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS moi30_push_log (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            kind ENUM('support', 'inactive') NOT NULL,
            successful_devices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX moi30_push_log_user_time_idx (user_id, sent_at),
            CONSTRAINT moi30_push_log_user_fk FOREIGN KEY (user_id) REFERENCES moi30_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ];

    foreach ($statements as $statement) {
        $pdo->exec($statement);
    }

    $column = $pdo->query("SHOW COLUMNS FROM moi30_users LIKE 'last_seen_at'")->fetch();
    if (!$column) {
        $pdo->exec('ALTER TABLE moi30_users ADD COLUMN last_seen_at DATETIME NULL AFTER must_change_password');
    }

    $lock = $pdo->query("SELECT GET_LOCK('moi30_seed_lock', 10)")->fetchColumn();
    if ((string)$lock !== '1') {
        throw new RuntimeException('Unable to acquire seed lock.');
    }

    try {
        $count = (int)$pdo->query('SELECT COUNT(*) FROM moi30_users')->fetchColumn();
        if ($count === 0) {
            $admin = $config['admin'] ?? [];
            $lia = $config['lia'] ?? [];
            if (!valid_username($admin['username'] ?? null) || !valid_password($admin['password'] ?? null)
                || !valid_username($lia['username'] ?? null) || !valid_password($lia['password'] ?? null)) {
                throw new RuntimeException('Initial account configuration is invalid.');
            }

            $pdo->beginTransaction();
            create_seed_user($pdo, (string)$admin['username'], (string)$admin['password'], 'admin', empty_state());
            create_seed_user($pdo, (string)$lia['username'], (string)$lia['password'], 'user', lia_state());
            $pdo->commit();
        }
        $pdo->exec('DELETE FROM moi30_sessions WHERE expires_at <= UTC_TIMESTAMP()');
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('moi30_seed_lock')");
    }
}

function create_seed_user(PDO $pdo, string $username, string $password, string $role, array $state): void
{
    $id = uuid_v4();
    $statement = $pdo->prepare(
        'INSERT INTO moi30_users (id, username, username_key, password_hash, role, must_change_password)
         VALUES (?, ?, ?, ?, ?, 1)'
    );
    $statement->execute([$id, trim($username), username_key($username), password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]), $role]);
    insert_state($pdo, $id, $state);
}

function route_request(PDO $pdo, array $config): never
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $path = '/' . ltrim($path, '/');
    $path = rtrim($path, '/') ?: '/';

    if ($method === 'GET' && $path === '/api/health') {
        $pdo->query('SELECT 1');
        respond(200, ['ok' => true]);
    }

    if ($method === 'POST' && $path === '/api/auth/register') {
        enforce_rate_limit($pdo, 'register');
        $body = read_json_body();
        $username = $body['username'] ?? null;
        $password = $body['password'] ?? null;
        if (!valid_username($username)) {
            respond(400, ['error' => 'INVALID_USERNAME']);
        }
        if (!valid_password($password)) {
            respond(400, ['error' => 'INVALID_PASSWORD']);
        }

        $pdo->beginTransaction();
        try {
            $id = uuid_v4();
            $statement = $pdo->prepare(
                "INSERT INTO moi30_users (id, username, username_key, password_hash, role, must_change_password)
                 VALUES (?, ?, ?, ?, 'user', 0)"
            );
            $statement->execute([
                $id,
                trim((string)$username),
                username_key((string)$username),
                password_hash((string)$password, PASSWORD_BCRYPT, ['cost' => 12]),
            ]);
            insert_state($pdo, $id, empty_state());
            $pdo->commit();
            $user = find_user_by_id($pdo, $id);
            issue_session($pdo, $config, $id);
            respond(201, ['user' => public_user($user)]);
        } catch (PDOException $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            if ((string)$error->getCode() === '23000') {
                respond(409, ['error' => 'USERNAME_TAKEN']);
            }
            throw $error;
        }
    }

    if ($method === 'POST' && $path === '/api/auth/login') {
        enforce_rate_limit($pdo, 'login');
        $body = read_json_body();
        $username = $body['username'] ?? null;
        $password = $body['password'] ?? null;
        if (!valid_username($username) || !is_string($password)) {
            respond(401, ['error' => 'INVALID_CREDENTIALS']);
        }

        $statement = $pdo->prepare('SELECT * FROM moi30_users WHERE username_key = ? LIMIT 1');
        $statement->execute([username_key((string)$username)]);
        $user = $statement->fetch();
        if (!$user || !password_verify($password, $user['password_hash'])) {
            respond(401, ['error' => 'INVALID_CREDENTIALS']);
        }
        issue_session($pdo, $config, $user['id']);
        respond(200, ['user' => public_user($user)]);
    }

    $auth = require_auth($pdo);
    $user = $auth['user'];

    if ($method === 'GET' && $path === '/api/auth/me') {
        respond(200, ['user' => public_user($user)]);
    }

    if ($method === 'POST' && $path === '/api/auth/logout') {
        $statement = $pdo->prepare('DELETE FROM moi30_sessions WHERE token_hash = ?');
        $statement->execute([$auth['token_hash']]);
        clear_session_cookie();
        http_response_code(204);
        exit;
    }

    if ($method === 'POST' && $path === '/api/auth/change-password') {
        enforce_rate_limit($pdo, 'change-password');
        $body = read_json_body();
        $currentPassword = (string)($body['currentPassword'] ?? '');
        $newPassword = $body['newPassword'] ?? null;
        if (!password_verify($currentPassword, $user['password_hash'])) {
            respond(400, ['error' => 'WRONG_PASSWORD']);
        }
        if (!valid_password($newPassword)) {
            respond(400, ['error' => 'INVALID_PASSWORD']);
        }
        if (password_verify((string)$newPassword, $user['password_hash'])) {
            respond(400, ['error' => 'PASSWORD_UNCHANGED']);
        }

        $statement = $pdo->prepare(
            'UPDATE moi30_users SET password_hash = ?, must_change_password = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?'
        );
        $statement->execute([password_hash((string)$newPassword, PASSWORD_BCRYPT, ['cost' => 12]), $user['id']]);
        $statement = $pdo->prepare('DELETE FROM moi30_sessions WHERE user_id = ? AND token_hash <> ?');
        $statement->execute([$user['id'], $auth['token_hash']]);
        respond(200, ['ok' => true]);
    }

    if ($method === 'GET' && $path === '/api/push/config') {
        if ((bool)$user['must_change_password']) {
            respond(403, ['error' => 'PASSWORD_CHANGE_REQUIRED']);
        }
        $publicKey = $config['push']['publicKey'] ?? null;
        respond(200, [
            'available' => is_string($publicKey) && $publicKey !== '',
            'publicKey' => is_string($publicKey) ? $publicKey : '',
        ]);
    }

    if ($method === 'POST' && $path === '/api/push/subscribe') {
        if ((bool)$user['must_change_password']) {
            respond(403, ['error' => 'PASSWORD_CHANGE_REQUIRED']);
        }
        if (!push_is_configured($config)) {
            respond(503, ['error' => 'PUSH_UNAVAILABLE']);
        }
        $body = read_json_body();
        $subscription = valid_push_subscription($body['subscription'] ?? null);
        if ($subscription === null) {
            respond(400, ['error' => 'INVALID_PUSH_SUBSCRIPTION']);
        }
        $timezone = valid_timezone($body['timezone'] ?? null);
        $statement = $pdo->prepare(
            'INSERT INTO moi30_push_subscriptions
                (user_id, endpoint_hash, endpoint, p256dh, auth_token, timezone, enabled)
             VALUES (?, ?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id), endpoint = VALUES(endpoint), p256dh = VALUES(p256dh),
                auth_token = VALUES(auth_token), timezone = VALUES(timezone), enabled = 1,
                updated_at = UTC_TIMESTAMP()'
        );
        $statement->execute([
            $user['id'], hash('sha256', $subscription['endpoint']), $subscription['endpoint'],
            $subscription['keys']['p256dh'], $subscription['keys']['auth'], $timezone,
        ]);
        respond(200, ['ok' => true]);
    }

    if ($method === 'DELETE' && $path === '/api/push/subscribe') {
        $body = read_json_body();
        $endpoint = $body['endpoint'] ?? null;
        if (!is_string($endpoint) || $endpoint === '' || strlen($endpoint) > 2048) {
            respond(400, ['error' => 'INVALID_PUSH_SUBSCRIPTION']);
        }
        $statement = $pdo->prepare(
            'DELETE FROM moi30_push_subscriptions WHERE user_id = ? AND endpoint_hash = ?'
        );
        $statement->execute([$user['id'], hash('sha256', $endpoint)]);
        http_response_code(204);
        exit;
    }

    if ($method === 'GET' && $path === '/api/state') {
        if ((bool)$user['must_change_password']) {
            respond(403, ['error' => 'PASSWORD_CHANGE_REQUIRED']);
        }
        $statement = $pdo->prepare('SELECT state, revision, updated_at FROM moi30_user_states WHERE user_id = ?');
        $statement->execute([$user['id']]);
        $row = $statement->fetch();
        $row['state'] = json_decode($row['state'], true, 128, JSON_THROW_ON_ERROR);
        respond(200, $row);
    }

    if ($method === 'PUT' && $path === '/api/state') {
        if ((bool)$user['must_change_password']) {
            respond(403, ['error' => 'PASSWORD_CHANGE_REQUIRED']);
        }
        $body = read_json_body();
        $revision = $body['revision'] ?? null;
        $state = sanitize_state($body['state'] ?? null);
        if (!is_int($revision) || $revision < 0 || $state === null) {
            respond(400, ['error' => 'INVALID_STATE']);
        }

        $statement = $pdo->prepare(
            'UPDATE moi30_user_states
             SET state = ?, revision = revision + 1, updated_at = UTC_TIMESTAMP()
             WHERE user_id = ? AND revision = ?'
        );
        $statement->execute([encode_json($state), $user['id'], $revision]);
        if ($statement->rowCount() === 0) {
            $current = $pdo->prepare('SELECT state, revision, updated_at FROM moi30_user_states WHERE user_id = ?');
            $current->execute([$user['id']]);
            $row = $current->fetch();
            $row['state'] = json_decode($row['state'], true, 128, JSON_THROW_ON_ERROR);
            respond(409, ['error' => 'STATE_CONFLICT', 'current' => $row]);
        }
        $current = $pdo->prepare('SELECT state, revision, updated_at FROM moi30_user_states WHERE user_id = ?');
        $current->execute([$user['id']]);
        $row = $current->fetch();
        $row['state'] = json_decode($row['state'], true, 128, JSON_THROW_ON_ERROR);
        respond(200, $row);
    }

    respond(404, ['error' => 'NOT_FOUND']);
}

function read_json_body(): array
{
    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > MAX_BODY_BYTES) {
        respond(413, ['error' => 'INVALID_STATE']);
    }
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        respond(413, ['error' => 'INVALID_STATE']);
    }
    try {
        $body = json_decode($raw, true, 128, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        respond(400, ['error' => 'INVALID_REQUEST']);
    }
    if (!is_array($body)) {
        respond(400, ['error' => 'INVALID_REQUEST']);
    }
    return $body;
}

function require_auth(PDO $pdo): array
{
    $token = $_COOKIE[COOKIE_NAME] ?? null;
    if (!is_string($token) || $token === '') {
        respond(401, ['error' => 'AUTH_REQUIRED']);
    }
    $tokenHash = hash('sha256', $token);
    $statement = $pdo->prepare(
        'SELECT u.* FROM moi30_sessions s
         INNER JOIN moi30_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
         LIMIT 1'
    );
    $statement->execute([$tokenHash]);
    $user = $statement->fetch();
    if (!$user) {
        clear_session_cookie();
        respond(401, ['error' => 'AUTH_REQUIRED']);
    }
    $seen = $pdo->prepare('UPDATE moi30_users SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?');
    $seen->execute([$user['id']]);
    return ['user' => $user, 'token_hash' => $tokenHash];
}

function push_is_configured(array $config): bool
{
    $push = $config['push'] ?? [];
    return is_array($push)
        && is_string($push['subject'] ?? null) && $push['subject'] !== ''
        && is_string($push['publicKey'] ?? null) && $push['publicKey'] !== ''
        && is_string($push['privateKey'] ?? null) && $push['privateKey'] !== '';
}

function valid_push_subscription(mixed $value): ?array
{
    if (!is_array($value) || !is_string($value['endpoint'] ?? null)
        || strlen($value['endpoint']) < 10 || strlen($value['endpoint']) > 2048
        || !filter_var($value['endpoint'], FILTER_VALIDATE_URL)
        || strtolower((string)parse_url($value['endpoint'], PHP_URL_SCHEME)) !== 'https'
        || !is_array($value['keys'] ?? null)
        || !is_string($value['keys']['p256dh'] ?? null)
        || !is_string($value['keys']['auth'] ?? null)
        || preg_match('/^[A-Za-z0-9_-]{40,255}$/', $value['keys']['p256dh']) !== 1
        || preg_match('/^[A-Za-z0-9_-]{12,255}$/', $value['keys']['auth']) !== 1) {
        return null;
    }
    return [
        'endpoint' => $value['endpoint'],
        'keys' => ['p256dh' => $value['keys']['p256dh'], 'auth' => $value['keys']['auth']],
    ];
}

function valid_timezone(mixed $value): string
{
    if (!is_string($value) || strlen($value) > 64) {
        return 'UTC';
    }
    static $known = null;
    $known ??= array_fill_keys(timezone_identifiers_list(), true);
    return isset($known[$value]) ? $value : 'UTC';
}

function issue_session(PDO $pdo, array $config, string $userId): void
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $days = max(1, min(90, (int)($config['session_days'] ?? 30)));
    $expires = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $expires = $expires->modify('+' . $days . ' days');
    $statement = $pdo->prepare('INSERT INTO moi30_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    $statement->execute([hash('sha256', $token), $userId, $expires->format('Y-m-d H:i:s')]);
    setcookie(COOKIE_NAME, $token, [
        'expires' => $expires->getTimestamp(),
        'path' => '/',
        'secure' => request_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function clear_session_cookie(): void
{
    setcookie(COOKIE_NAME, '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => request_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function request_is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
        || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function public_user(array $row): array
{
    return [
        'id' => $row['id'],
        'username' => $row['username'],
        'role' => $row['role'],
        'mustChangePassword' => (bool)$row['must_change_password'],
    ];
}

function find_user_by_id(PDO $pdo, string $id): array
{
    $statement = $pdo->prepare('SELECT * FROM moi30_users WHERE id = ? LIMIT 1');
    $statement->execute([$id]);
    $user = $statement->fetch();
    if (!$user) {
        throw new RuntimeException('New user was not found.');
    }
    return $user;
}

function insert_state(PDO $pdo, string $userId, array $state): void
{
    $statement = $pdo->prepare('INSERT INTO moi30_user_states (user_id, state, revision) VALUES (?, ?, 0)');
    $statement->execute([$userId, encode_json($state)]);
}

function enforce_rate_limit(PDO $pdo, string $action): void
{
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $key = hash('sha256', $action . '|' . $ip);
    $statement = $pdo->prepare(
        "INSERT INTO moi30_rate_limits (key_hash, window_started, hits)
         VALUES (?, UTC_TIMESTAMP(), 1)
         ON DUPLICATE KEY UPDATE
           hits = IF(window_started < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), 1, hits + 1),
           window_started = IF(window_started < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), UTC_TIMESTAMP(), window_started)"
    );
    $statement->execute([$key]);
    $statement = $pdo->prepare('SELECT hits FROM moi30_rate_limits WHERE key_hash = ?');
    $statement->execute([$key]);
    if ((int)$statement->fetchColumn() > 40) {
        header('Retry-After: 900');
        respond(429, ['error' => 'TOO_MANY_REQUESTS']);
    }
}

function valid_username(mixed $value): bool
{
    if (!is_string($value)) {
        return false;
    }
    $value = trim($value);
    return preg_match('/^[\p{L}\p{N}_.-]{3,32}$/u', $value) === 1;
}

function valid_password(mixed $value): bool
{
    return is_string($value) && strlen($value) >= 10 && strlen($value) <= 200;
}

function username_key(string $value): string
{
    $value = trim($value);
    return function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
}

function valid_date_key(mixed $value): bool
{
    if (!is_string($value) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) !== 1) {
        return false;
    }
    [$year, $month, $day] = array_map('intval', explode('-', $value));
    return $year >= 1 && checkdate($month, $day, $year);
}

function sanitize_state(mixed $state): ?array
{
    if (!is_array($state) || ($state['version'] ?? null) !== 5 || !valid_date_key($state['start'] ?? null)
        || !isset($state['habits']) || !is_array($state['habits']) || count($state['habits']) > 500) {
        return null;
    }

    $habits = [];
    $knownIds = [];
    $openSlots = [];
    foreach ($state['habits'] as $habit) {
        if (!is_array($habit) || !is_int($habit['id'] ?? null) || $habit['id'] < 0
            || !is_int($habit['slot'] ?? null) || $habit['slot'] < 0
            || isset($knownIds[$habit['id']]) || !is_string($habit['name'] ?? null)
            || trim($habit['name']) === '' || unicode_length(trim($habit['name'])) > 130
            || !is_string($habit['icon'] ?? null) || !in_array($habit['group'] ?? null, GROUPS, true)
            || !is_array($habit['days'] ?? null)) {
            return null;
        }
        $days = [];
        foreach ($habit['days'] as $day) {
            if (!is_int($day) || $day < 0 || $day > 6) {
                return null;
            }
            $days[$day] = true;
        }
        $days = array_map('intval', array_keys($days));
        sort($days);
        $startDate = $habit['startDate'] ?? null;
        $endDate = $habit['endDate'] ?? null;
        if (($startDate !== null && !valid_date_key($startDate)) || ($endDate !== null && !valid_date_key($endDate))
            || ($startDate !== null && $endDate !== null && $startDate > $endDate)) {
            return null;
        }
        if ($endDate === null) {
            if (isset($openSlots[$habit['slot']])) {
                return null;
            }
            $openSlots[$habit['slot']] = true;
        }
        $knownIds[$habit['id']] = true;
        $habits[] = [
            'id' => $habit['id'],
            'slot' => $habit['slot'],
            'name' => trim($habit['name']),
            'icon' => trim_unicode($habit['icon'], 16, '🌱'),
            'group' => $habit['group'],
            'days' => $days,
            'startDate' => $startDate,
            'endDate' => $endDate,
        ];
    }

    if ($habits !== []) {
        $maxSlot = max(array_column($habits, 'slot'));
        for ($slot = 0; $slot <= $maxSlot; $slot++) {
            if (!isset($openSlots[$slot])) {
                return null;
            }
        }
    }

    $entries = [];
    $sourceEntries = $state['entries'] ?? [];
    if (!is_array($sourceEntries) || count($sourceEntries) > 5000) {
        return null;
    }
    foreach ($sourceEntries as $date => $entry) {
        if (!valid_date_key((string)$date) || !is_array($entry)) {
            continue;
        }
        $statuses = [];
        foreach (($entry['statuses'] ?? []) as $id => $status) {
            $numericId = filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
            if ($numericId !== false && isset($knownIds[$numericId]) && in_array($status, ['done', 'small'], true)) {
                $statuses[(string)$numericId] = $status;
            }
        }
        $mood = $entry['mood'] ?? null;
        $entries[(string)$date] = [
            'statuses' => $statuses === [] ? new stdClass() : $statuses,
            'gentle' => (bool)($entry['gentle'] ?? false),
            'mood' => is_int($mood) && $mood >= 1 && $mood <= 5 ? $mood : null,
            'note' => is_string($entry['note'] ?? null) ? unicode_substr($entry['note'], 0, 20000) : '',
        ];
    }

    $reflections = [];
    $sourceReflections = $state['reflections'] ?? [];
    if (!is_array($sourceReflections) || count($sourceReflections) > 1000) {
        return null;
    }
    foreach ($sourceReflections as $key => $value) {
        if (is_string($value)) {
            $reflections[(string)$key] = unicode_substr($value, 0, 20000);
        }
    }

    return [
        'version' => 5,
        'start' => $state['start'],
        'habits' => $habits,
        'entries' => $entries === [] ? new stdClass() : $entries,
        'reflections' => $reflections === [] ? new stdClass() : $reflections,
    ];
}

function unicode_length(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function unicode_substr(string $value, int $start, int $length): string
{
    return function_exists('mb_substr') ? mb_substr($value, $start, $length, 'UTF-8') : substr($value, $start, $length);
}

function trim_unicode(string $value, int $maxLength, string $fallback): string
{
    $value = trim($value);
    if ($value === '') {
        return $fallback;
    }
    return unicode_substr($value, 0, $maxLength);
}

function empty_state(): array
{
    return [
        'version' => 5,
        'start' => date('Y-m-d'),
        'habits' => [],
        'entries' => new stdClass(),
        'reflections' => new stdClass(),
    ];
}

function lia_state(): array
{
    $defaults = [
        ['⏰', 'Подъём 08:00, сон 22:00', 'Забота о себе'],
        ['🥗', 'Чистое питание', 'Забота о себе'],
        ['💪', 'Тренировка (силовая / тазового дна)', 'Забота о себе'],
        ['💧', '3,5 литра воды', 'Забота о себе'],
        ['🌿', 'Протокол', 'Забота о себе'],
        ['👟', '10 000 шагов', 'Забота о себе'],
        ['🌳', 'Прогулка', 'Забота о себе'],
        ['💆', 'Массаж лица', 'Уход'],
        ['🫧', 'Уход за лицом', 'Уход'],
        ['🧘', 'Атма-крия', 'Духовная практика'],
        ['📜', 'Чтение священных писаний', 'Духовная практика'],
        ['🧹', 'Уборка', 'Дом и развитие'],
        ['📚', 'Самообразование', 'Дом и развитие'],
        ['🪷', 'Курс «Пробуждение души»', 'Дом и развитие'],
        ['📵', 'Телефон — до 30 минут', 'Дом и развитие'],
        ['📣', 'Продвижение — 20 откликов', 'Дом и развитие'],
        ['🐕', 'Курс по послушанию собак', 'Дом и развитие'],
        ['💬', 'Домашка коуча', 'Дом и развитие'],
        ['🎨', 'Арт-терапия', 'Дом и развитие'],
    ];
    $habits = [];
    foreach ($defaults as $slot => $definition) {
        $habits[] = [
            'id' => $slot,
            'slot' => $slot,
            'name' => $definition[1],
            'icon' => $definition[0],
            'group' => $definition[2],
            'days' => [0, 1, 2, 3, 4, 5, 6],
            'startDate' => null,
            'endDate' => null,
        ];
    }
    return [
        'version' => 5,
        'start' => date('Y-m-d'),
        'habits' => $habits,
        'entries' => new stdClass(),
        'reflections' => new stdClass(),
    ];
}

function uuid_v4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), substr($hex, 12, 4), substr($hex, 16, 4), substr($hex, 20));
}

function encode_json(mixed $value): string
{
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

function respond(int $status, array $payload): never
{
    http_response_code($status);
    echo encode_json($payload);
    exit;
}

