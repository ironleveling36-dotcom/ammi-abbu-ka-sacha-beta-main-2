# Screenshot browser ke liye system libs (sirf local QA)

Is sandbox/image me `libnss3` / `libnspr4` nahi hote, isliye headless Chromium
(`@sparticuz/chromium`) start hi nahi hota:

```
/tmp/chromium: error while loading shared libraries: libnspr4.so: cannot open ...
```

`setup.sh` do kaam karta hai:

1. NSS/nspr ki **asli** libraries ek public repo se `libnss-stub/` me laata hai.
2. `libnss3.so` ko ek **screenshot-only stub** se replace karta hai jo sirf wahi 38 symbols
   export karta hai jo Chromium maangta hai (`PK11_HasAttributeSet@NSS_3.30` etc.).
   Preview server plain HTTP hai, isliye TLS/NSS ka asli path kabhi chalta hi nahi.

⚠️ Ye sirf **local screenshot QA** ke liye hai. Production app ise use nahi karta, aur
`libnss-stub/` git me commit nahi hoti (`.gitignore`).

Chalane ka tareeqa:

```bash
npm install --no-save --no-package-lock --ignore-scripts @sparticuz/chromium
node --input-type=module -e "import chromium from '@sparticuz/chromium'; console.log(await chromium.executablePath())"
bash tools/chromedeps/setup.sh
npm run preview:miniapp          # alag terminal; demo data only
npm run shots:miniapp            # → screenshots/*.png (390×844 @2x)
npm run test:miniapp-layout     # 320–430px, light/dark, sheets aur safe areas
```

Agar system Chromium available hai, `CHROME_PATH=/path/to/chromium npm run
test:miniapp-layout` use kar sakte hain; extra browser package aur stub zaroori
nahi hain. Verifier sirf visibly labelled demo preview par interact karta hai.
Isse real Swiggy order, payment, SMS ya Telegram device behaviour verify nahi
hota.
