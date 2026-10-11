/**
 * Haraka Metadata Normalization & List-Unsubscribe Body Injection Plugin (Disabled)
 * 退订头与HTML正文注入已移至发件器(injector)统一控制，本插件仅作为空钩子保留兼容，不修改邮件内容。
 */

exports.hook_data = function(next, connection) {
    return next();
};

exports.hook_data_post = function(next, connection) {
    return next();
};
