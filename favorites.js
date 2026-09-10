/**
 * Общая логика "избранного" для index.html и master.html.
 * Хранит список ID журналов, чьи формы отмечены как избранные,
 * в localStorage браузера (привязано к устройству, без сервера).
 */

const FAVORITES_KEY = 'gcheck_favorite_forms';

function getFavorites(){
  try{
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  } catch(e){
    return [];
  }
}

function isFavorite(id){
  return getFavorites().includes(id);
}

function toggleFavorite(id){
  const current = getFavorites();
  const idx = current.indexOf(id);
  if(idx === -1){
    current.push(id);
  } else {
    current.splice(idx, 1);
  }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(current));
  return current.includes(id);
}
