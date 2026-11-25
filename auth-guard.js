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

  window.gcheckCanViewTestResults = function(){
    var user = window.gcheckUser;
    if(!user) return false;
    var positions = String(user.position || user.type || '').toLowerCase().split(',');
    return positions.some(function(position){
      return ['администратор', 'сотрудник окк'].includes(position.trim());
    });
  };

  window.gcheckRequest = async function(action, params = {}){
    var user = window.gcheckUser;
    if(!user || !user.token) throw new Error('invalid');

    var response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...params, action, token: user.token })
    });
    if(!response.ok) throw new Error('network');
    var data = await response.json();
    if(!data || !data.ok) throw new Error(data && data.error || 'server');
    return data;
  };

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

  function updateUser(session){
    window.gcheckUser = {
      name: session.name, type: session.type, position: session.position,
      allowed: session.allowed, blocks: session.blocks, token: session.token
    };
  }

  updateUser(s);

  if(!s.checkedAt || !s.allowed || !Array.isArray(s.blocks) || Date.now() - s.checkedAt > RECHECK_MS){
    fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'verify', token: s.token })
    })
      .then(function(r){ return r.json(); })
      .then(function(res){
        var cur = readSession();
        if(!cur || cur.token !== s.token) return;
        if(res && res.ok){
          cur.checkedAt = Date.now();
          cur.name = res.name || cur.name;
          cur.type = res.type || cur.type;
          cur.position = res.position;
          cur.allowed = res.allowed;
          if(Array.isArray(res.blocks)) cur.blocks = res.blocks;
          localStorage.setItem(AUTH_KEY, JSON.stringify(cur));
          updateUser(cur);
          document.dispatchEvent(new Event('gcheck:user'));
        } else if(res && (res.error === 'invalid' || res.error === 'expired' || res.error === 'inactive')){
          toLogin();
        }
        // прочие ошибки сервера игнорируем, чтобы сбой скрипта не выкидывал всех
      })
      .catch(function(){ /* нет сети — остаёмся в системе (PWA/офлайн) */ });
  }
})();
