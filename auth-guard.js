// auth-guard.js
// Подключать первым скриптом в <head>, ДО остального контента страницы:
// <script src="auth-guard.js"></script>
//
// Если в браузере нет действующего токена — отправляет на login.html.
// Раз в несколько минут (в фоне) спрашивает сервер, не отключили ли пользователя
// и не сменили ли ему пинкод; если да — выходит из аккаунта.
// Это удобство, а не защита: настоящая проверка токена происходит на сервере.
(function(){
  var AUTH_KEY = 'gcheck_auth';
  var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw65iyi4m1X3Bu1KIrcJwiQCnqQ83odteQc2MtEYnkEjHCiVqQV6sIVwJoUYrCQFR2ALQ/exec';
  var RECHECK_MS = 10 * 60 * 1000; // как часто сверяться с сервером

  function readSession(){
    try{ return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
    catch(e){ return null; }
  }

  function toLogin(){
    localStorage.removeItem(AUTH_KEY);
    var here = encodeURIComponent(location.pathname.split('/').pop() + location.search);
    location.replace('login.html?redirect=' + here);
  }

  // Выход по кнопке: window.gcheckLogout()
  window.gcheckLogout = function(){
    localStorage.removeItem(AUTH_KEY);
    location.replace('login.html');
  };

  var s = readSession();
  if(!s || !s.token || !s.exp || Date.now() >= s.exp){
    toLogin();
    return;
  }

  // Данные вошедшего для страниц: window.gcheckUser.name / .type / .token
  window.gcheckUser = { name: s.name, type: s.type, position: s.position, allowed: s.allowed, token: s.token };

if(!s.checkedAt || !s.allowed || Date.now() - s.checkedAt > RECHECK_MS){
    fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'verify', token: s.token })
    })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if(res && res.ok){
          var cur = readSession();
          if(cur){
            cur.checkedAt = Date.now();
            cur.name = res.name || cur.name;
            cur.type = res.type || cur.type;
            cur.position = res.position;
            cur.allowed = res.allowed;
            localStorage.setItem(AUTH_KEY, JSON.stringify(cur));
            window.gcheckUser = { name: cur.name, type: cur.type, position: cur.position, allowed: cur.allowed, token: cur.token };
            document.dispatchEvent(new Event('gcheck:user'));
          }
        } else if(res && (res.error === 'invalid' || res.error === 'expired' || res.error === 'inactive')){
          toLogin();
        }
        // прочие ошибки сервера игнорируем, чтобы сбой скрипта не выкидывал всех
      })
      .catch(function(){ /* нет сети — остаёмся в системе (PWA/офлайн) */ });
  }
})();
