<?php
declare(strict_types=1);

use Minishlink\WebPush\VAPID;

require __DIR__ . '/vendor/autoload.php';

$target = dirname(__DIR__) . '/moi30-push-config.php';
if (is_file($target)) {
    fwrite(STDERR, "Push configuration already exists.\n");
    exit(1);
}

$keys = VAPID::createVapidKeys();
$config = [
    'subject' => 'https://liyatrkr.ru',
    'publicKey' => $keys['publicKey'],
    'privateKey' => $keys['privateKey'],
];
$contents = "<?php\ndeclare(strict_types=1);\n\nreturn " . var_export($config, true) . ";\n";
if (file_put_contents($target, $contents, LOCK_EX) === false) {
    fwrite(STDERR, "Unable to write push configuration.\n");
    exit(1);
}
chmod($target, 0600);
fwrite(STDOUT, "Push configuration created.\n");
