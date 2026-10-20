<?php
declare(strict_types=1);

// Copy this file outside the public web directory and replace every secret.
return [
    'db' => [
        'host' => 'localhost',
        'name' => 'database_name',
        'user' => 'database_user',
        'password' => 'replace-me',
    ],
    'admin' => [
        'username' => 'admin',
        'password' => 'replace-with-a-long-random-password',
    ],
    'lia' => [
        'username' => 'Лия',
        'password' => 'replace-with-a-long-random-password',
    ],
    'session_days' => 30,
    'timezone' => 'Asia/Yekaterinburg',
];

