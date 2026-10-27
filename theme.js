(function(){
  const key='aurum.theme';
  const choices=['light','dark','system'];
  const media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
  let preference='system';
  try{const saved=localStorage.getItem(key);if(choices.includes(saved))preference=saved;}catch{}
  function apply(){
    const effective=preference==='system'?(media?.matches?'dark':'light'):preference;
    document.documentElement.dataset.theme=effective;
    document.documentElement.style.colorScheme=effective;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',effective==='dark'?'#10191e':'#f4f6f7');
  }
  globalThis.AurumTheme={get:()=>preference,set(value){if(!choices.includes(value))return;preference=value;try{localStorage.setItem(key,value);}catch{}apply();}};
  media?.addEventListener('change',()=>{if(preference==='system')apply();});
  globalThis.addEventListener?.('storage',event=>{if(event.key===key){preference=choices.includes(event.newValue)?event.newValue:'system';apply();}});
  apply();
})();
