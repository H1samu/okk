// auth-guard.js
// Подключить самым первым скриптом в <head>, ДО остального контента страницы:
// <script src="auth-guard.js"></script>
//
// Если пользователь не входил через login.html за последние 24 часа —
// сразу редиректит его туда. Не защита данных, только от случайных людей.
(function(){
  var SESSION_KEY = "gcheck_auth_time";
  var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 24 часа

  var savedTime = parseInt(localStorage.getItem(SESSION_KEY) || '0', 10);
  var isValid = savedTime && (Date.now() - savedTime) < SESSION_TTL_MS;

  if(!isValid){
    localStorage.removeItem(SESSION_KEY);
    var here = encodeURIComponent(location.pathname.split('/').pop() + location.search);
    location.replace('login.html?redirect=' + here);
  }
})();
