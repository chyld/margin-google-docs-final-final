// Sets the light/dark theme before the first paint, so the page never flashes the wrong colors.
// Loaded as a blocking script in <head> (the CSP forbids inline scripts). The app (web/src/theme.ts)
// owns the setting afterwards; this file only bootstraps and follows the system while set to "system".
;(function () {
  var root = document.documentElement
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  function preference() {
    try {
      var value = window.localStorage.getItem('margin:theme')
      return value === 'light' || value === 'dark' ? value : 'system'
    } catch (error) {
      return 'system'
    }
  }
  function apply() {
    var choice = preference()
    var dark = choice === 'dark' || (choice === 'system' && !!media && media.matches)
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#171714' : '#f2f0eb')
  }
  apply()
  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (preference() === 'system') apply()
    })
  }
})()
