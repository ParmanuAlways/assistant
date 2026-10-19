<?php
// Demo webmail for the agent tests: Roundcube on the GreenMail IMAP/SMTP server.
$config = [];
$config['db_dsnw'] = 'sqlite:////home/user/browser-agent/mail/roundcube.db?mode=0646';
$config['imap_host'] = '127.0.0.1:3143';
$config['smtp_host'] = '127.0.0.1:3025';
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';
$config['support_url'] = '';
$config['product_name'] = 'Acme Webmail';
$config['des_key'] = 'demo-key-24-chars-long!!';
$config['plugins'] = ['archive'];
$config['archive_mbox'] = 'Archive';
$config['skin'] = 'elastic';
$config['enable_installer'] = false;
$config['create_default_folders'] = true;
$config['mail_domain'] = 'office.local';
$config['username_domain'] = 'office.local';
$config['login_autocomplete'] = 2;
$config['htmleditor'] = 0;            // plain-text compose
$config['draft_autosave'] = 0;
$config['log_dir'] = '/home/user/browser-agent/mail/logs/';
$config['temp_dir'] = '/home/user/browser-agent/mail/temp/';
