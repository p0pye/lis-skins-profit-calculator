// ==UserScript==
// @name         lis-skins-profit-calculator
// @namespace    http://tampermonkey.net
// @version      12.5
// @description  lis-skins-profit-calculator
// @author       AI Helper
// @match        https://lis-skins.com/*/market/*
// @icon         https://google.com
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let panelInjected = false;
    let activeSteamRequests = 0; // Счетчик активных запросов к Steam для контроля сортировки
    let steamRequestsQueue = []; // Массив для хранения очереди задач
    let steamCache = {};
    let isQueueRunning = false; // Флаг, запущен ли процесс обработки

    async function processNextSteamRequest() {
        if (isQueueRunning) return; // Предотвращаем повторный множественный запуск менеджера
        isQueueRunning = true;

        const CONCURRENCY = 7; // Количество одновременных запросов к Steam
        const statusDiv = document.getElementById('combine-status');

        // Функция-воркер, которая берет задачи из общей очереди
        const worker = async () => {
            while (steamRequestsQueue.length > 0) {
                const task = steamRequestsQueue.shift();
                if (!task) continue;

                // ШАГ 1: Проверка кэша. Если этот скин уже загружали — берем данные мгновенно
                if (steamCache[task.marketHashName]) {
                    const cached = steamCache[task.marketHashName];
                    task.targetLinkElement.innerText = formatPriceWithProfit(cached.priceText, task.targetLinkElement, cached.ordersCount);
                    task.targetLinkElement.style.background = '#43b581';
                    task.totalCard.setAttribute('data-calculated-profit', cached.calculatedProfit);

                    continue;
                }

                // ШАГ 2: Если в кэше нет — отправляем сетевой запрос
                task.targetLinkElement.innerText = 'Загрузка...';

                await new Promise((resolve) => {
                    fetchSteamPriceFromHTML(task.targetUrl, task.marketHashName, task.targetLinkElement, task.totalCard, (status, data) => {
                        if (status === 429) {
                            if (statusDiv) statusDiv.innerText = "Steam Блок 429! Пауза 30с...";
                            steamRequestsQueue.unshift(task); // Возвращаем в очередь
                            task.targetLinkElement.innerText = 'Пауза 429...';
                            setTimeout(resolve, 30000); // При блоке жесткая пауза 30 сек
                        } else {
                            // Сохраняем успешный результат в кэш, чтобы не запрашивать повторно дубликаты
                            if (status === 200 && data) {
                                steamCache[task.marketHashName] = data;
                            }
                            // Безопасная, но ускоренная пауза между запросами в одном потоке (1.2 - 2 секунды)
                            const delay = 1200 + Math.random() * 800;
                            setTimeout(resolve, delay);
                        }
                    });
                });
            }
        };

        // Запускаем параллельных воркера из одного пула задач
        const workers = Array(CONCURRENCY).fill(null).map(() => worker());
        // Ждем, пока абсолютно все воркеры закончат работу с пулом задач
        await Promise.all(workers);

        // Железно вызываем сортировку один раз, когда всё гарантированно готово
        sortCardsByProfit();

        // Возвращаем кнопку в исходное активное состояние
        const btn = document.getElementById('start-combine');
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('lis-btn-disabled');
            btn.innerText = 'Загрузить и отфильтровать';
        }

        // Выводим всплывающее уведомление об успешном окончании
        showSuccessToast('Обновление цен и сортировка успешно завершены!');

        isQueueRunning = false;
    }

    // Функция вывода всплывающих уведомлений об ошибках (исчезает через 10 сек)
    function showErrorToast(message) {
        let container = document.getElementById('lis-error-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'lis-error-toast-container';
            container.style = 'position: fixed; top: 20px; right: 20px; z-index: 99999999; display: flex; flex-direction: column; gap: 10px;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style = `
            background: #f04747; color: #fff; padding: 12px 18px; border-radius: 6px;
            font-family: sans-serif; font-size: 13px; font-weight: bold;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5); border-left: 5px solid #bd362f;
            opacity: 1; transition: opacity 0.5s ease-in-out; min-width: 250px;
        `;
        toast.innerText = `⚠️ LIS Helper: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            // ОПТИМИЗАЦИЯ: Удаление элемента строго по окончании CSS-анимации
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 10000);
    }
    // Всплывающее уведомление об успешном завершении (зеленое, исчезает через 5 секунд)
    function showSuccessToast(message) {
        let container = document.getElementById('lis-error-toast-container'); // Используем тот же контейнер
        if (!container) {
            container = document.createElement('div');
            container.id = 'lis-error-toast-container';
            container.style = 'position: fixed; top: 20px; right: 20px; z-index: 99999999; display: flex; flex-direction: column; gap: 10px;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style = `
            background: #43b581; color: #fff; padding: 12px 18px; border-radius: 6px;
            font-family: sans-serif; font-size: 13px; font-weight: bold;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5); border-left: 5px solid #2e8b57;
            opacity: 1; transition: opacity 0.5s ease-in-out; min-width: 250px;
        `;
        toast.innerHTML = `✅ LIS Helper: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 5000);
    }

    // Инициализация и отрисовка боковой панели управления
    function injectPanel() {
        if (panelInjected || document.getElementById('lis-helper-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            @keyframes lis-spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .lis-spinner {
                display: inline-block;
                width: 12px;
                height: 12px;
                border: 2px solid rgba(255,255,255,0.3);
                border-radius: 50%;
                border-top-color: #fff;
                animation: lis-spin 1s ease-in-out infinite;
                margin-right: 6px;
                vertical-align: middle;
            }
            .lis-btn-disabled {
                opacity: 0.6 !important;
                cursor: not-allowed !important;
                background: #4f545c !important;
            }
        `;
        document.head.appendChild(style);

        const savedDiff = localStorage.getItem('lis_helper_min_diff') || '0';
        const savedPages = localStorage.getItem('lis_helper_pages_count') || '2';

        const panel = document.createElement('div');
        panel.id = 'lis-helper-panel';
        panel.style = `
            position: fixed; top: 140px; left: 20px; z-index: 9999999 !important;
            background: #1e2124 !important; color: #fff !important; padding: 15px !important;
            border-radius: 8px !important; border: 1px solid #36393e !important;
            box-shadow: 0 4px 15px rgba(0,0,0,0.8) !important; font-family: sans-serif !important;
            font-size: 13px !important; width: 210px !important; display: block !important;
        `;

        panel.innerHTML = `
            <div style="margin-bottom: 12px; font-weight: bold; color: #ff9800; text-align: center;">Мульти-страничный фильтр</div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <label>Мин. скидка (%):</label>
                <input type="number" id="diff-num-input" min="0" max="100" value="${savedDiff}" style="
                    width: 50px; background: #2f3136; color: #ff9800; border: 1px solid #4f545c;
                    padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                ">
            </div>
            <input type="range" id="min-diff-input" min="0" max="80" value="${Math.min(parseInt(savedDiff), 80)}" step="1" style="
                width: 100%; margin-bottom: 15px; cursor: pointer; accent-color: #ff9800;
            ">

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <label>Страниц собрать:</label>
                <input type="number" id="pages-num-input" min="1" max="99" value="${savedPages}" style="
                    width: 50px; background: #2f3136; color: #7289da; border: 1px solid #4f545c;
                    padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                ">
            </div>
            <input type="range" id="pages-to-load" min="1" max="99" value="${savedPages}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: #7289da;
            ">

            <button id="start-combine" style="width: 100%; background: #7289da; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight: bold;">Загрузить и отфильтровать</button>
            <div id="combine-status" style="margin-top: 8px; color: #aaa; font-size: 11px; text-align: center;"></div>
        `;

        if (document.body) {
            document.body.appendChild(panel);
            panelInjected = true;

            const pagesSlider = document.getElementById('pages-to-load');
            const pagesNumber = document.getElementById('pages-num-input');
            const diffSlider = document.getElementById('min-diff-input');
            const diffNumber = document.getElementById('diff-num-input');

            pagesSlider.addEventListener('input', function() {
                pagesNumber.value = this.value;
                localStorage.setItem('lis_helper_pages_count', this.value);
            });
            pagesNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 1;
                if (val > 99) val = 99; if (val < 1) val = 1;
                pagesSlider.value = val;
                localStorage.setItem('lis_helper_pages_count', val);
            });

            diffSlider.addEventListener('input', function() {
                diffNumber.value = this.value;
                localStorage.setItem('lis_helper_min_diff', this.value);
            });
            diffNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 0;
                if (val > 100) val = 100; if (val < 0) val = 0;
                diffSlider.value = Math.min(val, 80);
                localStorage.setItem('lis_helper_min_diff', val);
            });

            document.getElementById('start-combine').addEventListener('click', loadMorePages);
        }
    }

    // Парсинг цены автовыкупа на основе реальной DOM-структуры страницы Steam
    function fetchSteamPriceFromHTML(targetUrl, marketHashName, targetLinkElement, totalCard, onComplete) {

        GM_xmlhttpRequest({
            method: "GET",
            url: targetUrl,
            onload: function(response) {

                if (response.status === 429) {
                    if (onComplete) onComplete(429);
                    return;
                }

                if (response.status !== 200) {
                    console.error(`[LIS Helper Error] Код ${response.status} для "${marketHashName}"`);
                    showErrorToast(`Steam заблокировал запрос (Код ${response.status}). Сделайте паузу.`);
                    targetLinkElement.innerText = `Блок ${response.status}`;
                    targetLinkElement.style.background = '#f04747';
                    // Передаем статус ошибки в колбэк, чтобы воркер корректно перешел к следующей задаче
                    if (onComplete) onComplete(response.status);
                    return;
                }
                try {
                    const htmlText = response.responseText;
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    // ОПТИМИЗАЦИЯ: Ищем сразу элемент, содержащий нужный текст, вместо перебора всех span
                    const priceContainer = Array.from(doc.querySelectorAll('span')).find(span =>
                                                                                         span.textContent.includes('Заявок на покупку по цене')
                                                                                        );

                    let priceFound = false;
                    if (priceContainer) {
                        const priceSpan = priceContainer.querySelector('span');
                        if (priceSpan) {
                            let priceText = priceSpan.textContent.trim();
                            // Расчет выгоды и вывод в скобках

                            // Находим таблицу рядом с текстом цены и берем количество из второй ячейки первой строки
                            let ordersCount = '';
                            const nextTable = priceContainer.nextElementSibling || priceContainer.parentElement?.querySelector('table');
                            if (nextTable) {
                                const firstRowCells = nextTable.querySelectorAll('tbody tr:first-child td');
                                if (firstRowCells.length >= 2) {
                                    ordersCount = firstRowCells[1].textContent.trim().replace(/\s| /g, '');
                                }
                            }

                            // Передаем количество сделок в функцию форматирования текста
                            targetLinkElement.innerText = formatPriceWithProfit(priceText, targetLinkElement, ordersCount);

                            targetLinkElement.style.background = '#43b581';
                            priceFound = true;

                            // Сохраняем выгоду в карточку для последующей сортировки
                            const steamPrice = parseFloat(priceText.replace(/[^0-9.,]/g, '').replace(',', '.'));
                            const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;

                            // Записываем профит напрямую в колбэк и в дата-атрибут карточки здесь
                            const calculatedProfit = steamPrice - lisPrice;
                            totalCard.setAttribute('data-calculated-profit', calculatedProfit);

                            if (onComplete) onComplete(200, { priceText, ordersCount, calculatedProfit });


                        }
                    }

                    if (!priceFound) {
                        targetLinkElement.innerText = "Нет заявок";
                        targetLinkElement.style.background = '#ff9800';

                        // Если заявок нет, явно ставим низкий приоритет для сортировки
                        totalCard.setAttribute('data-calculated-profit', -999999);
                        if (onComplete) onComplete(200, null);

                        //console.Error(htmlText);
                    }
                } catch (e) {
                    console.error(`[LIS Helper Error] Сбой обработки DOM для "${marketHashName}":`, e);
                    targetLinkElement.innerText = "Ошибка структуры";
                    targetLinkElement.style.background = '#f04747';
                    // При ошибке структуры также уводим карточку вниз
                    totalCard.setAttribute('data-calculated-profit', -999999);
                    if (onComplete) onComplete('error');
                }

            },
            onerror: function(err) {
                console.error(`[LIS Helper Network Error] Сбой сети для "${marketHashName}":`, err);
                targetLinkElement.innerText = "Сбой сети";
                targetLinkElement.style.background = '#f04747';
                totalCard.setAttribute('data-calculated-profit', -999999);
                if (onComplete) onComplete('error');
            }
        });
    }

    // Вспомогательная функция для расчета чистой выгоды (Цена Steam - Цена LIS-SKINS)
    function formatPriceWithProfit(steamPriceRaw, targetLinkElement, ordersCount = '') {
        const steamPrice = parseFloat(steamPriceRaw.replace(/[^0-9.,]/g, '').replace(',', '.'));
        const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;

        // Формируем базовую строку цены и добавляем количество сделок (ордеров), если оно передано
        const ordersText = ordersCount ? ` [${ordersCount} шт.]` : '';
        let resultText = `${steamPrice.toFixed(2)} p.${ordersText}`;

        if (lisPrice > 0) {
            const profit = steamPrice - lisPrice;
            const profitSign = profit > 0 ? '+' : '';
            resultText += ` (${profitSign}${profit.toFixed(2)} p.)`;
        }
        return resultText;
    }

    // Функция сортировки карточек по значению выгоды (от большего к меньшему)
    function sortCardsByProfit() {
        const gridContainer = document.querySelector('.skins-market-skins-list');
        const statusDiv = document.getElementById('combine-status');
        if (!gridContainer) return;

        if (statusDiv) statusDiv.innerText = "Сортировка по выгоде...";

        // Получаем массив всех карточек
        const cardsArray = Array.from(gridContainer.querySelectorAll('.skins-market-skins-list > .item'));

        // Сортируем: карточки с большей выгодой идут вверх. Карточки без данных уходят вниз.
        cardsArray.sort((a, b) => {
            const profitA = parseFloat(a.getAttribute('data-calculated-profit')) || -999998;
            const profitB = parseFloat(b.getAttribute('data-calculated-profit')) || -999998;
            return profitB - profitA;
        });

        // Перепривязываем элементы в DOM в новом порядке
        cardsArray.forEach(card => gridContainer.appendChild(card));

        if (statusDiv) statusDiv.innerText = "Готово! Отсортировано.";
    }

    function applyDiffFilter() {
        const minVal = parseFloat(document.getElementById('diff-num-input').value) || 0;
        const allCards = document.querySelectorAll('.skins-market-skins-list .item');

        // ОПТИМИЗАЦИЯ: Вынесли определение AppID из цикла, чтобы не проверять URL на каждой карточке
        let currentAppId = 252490; // По умолчанию Rust
        const currentUrl = window.location.href;
        if (currentUrl.includes('/cs2/') || currentUrl.includes('/csgo/')) currentAppId = 730;
        else if (currentUrl.includes('/dota2/')) currentAppId = 570;

        steamRequestsQueue = [];

        allCards.forEach(totalCard => {
            totalCard.style.position = 'relative';
            const elem = totalCard.querySelector('.steam-price-discount');
            if (!elem || !elem.hasAttribute('data-diff-value')) {
                totalCard.style.display = 'none';
                return;
            }

            const rawAttr = elem.getAttribute('data-diff-value') || '';
            const attrValue = parseFloat(rawAttr.replace('%', ''));

            if (!isNaN(attrValue) && attrValue >= minVal) {
                totalCard.style.display = '';
                if (!totalCard.querySelector('.steam-highest-buy-order-link')) {
                    // ОПТИМИЗАЦИЯ: Группировка селекторов в один запрос
                    const titleElem = totalCard.querySelector('.name, .item-name, .inner-name');
                    let itemName = titleElem ? titleElem.innerText.trim() : "";

                    if (itemName) {
                        const steamLink = document.createElement('a');
                        steamLink.className = 'steam-highest-buy-order-link';
                        steamLink.target = '_blank';
                        steamLink.style = `
                        position: absolute; top: 10px; left: 10px; z-index: 9999;
                        background: #ff9800; color: #fff !important; padding: 3px 8px;
                        font-size: 11px; font-weight: bold; border-radius: 4px;
                        text-decoration: none !important; box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                        display: block;
                    `;
                        steamLink.innerText = 'Загрузка...';

                        // Парсим цену самого скина на LIS-SKINS и сохраняем в дата-атрибут ссылки
                        const lisPriceElem = totalCard.querySelector('.price');
                        const lisPrice = lisPriceElem ? parseFloat(lisPriceElem.innerText.replace(/[^0-9.,]/g, '').replace(',', '.')) : 0;
                        steamLink.setAttribute('data-lis-price', lisPrice);

                        const targetSteamUrl = `https://steamcommunity.com/market/listings/${currentAppId}/${encodeURIComponent(itemName)}`;
                        steamLink.setAttribute('href', targetSteamUrl);
                        totalCard.appendChild(steamLink);

                        // Добавляем задачу в очередь запросов
                        steamRequestsQueue.push({
                            targetUrl: targetSteamUrl,
                            marketHashName: itemName,
                            targetLinkElement: steamLink,
                            totalCard: totalCard
                        });
                    }
                }
            } else {
                totalCard.style.display = 'none';
            }
        });

        if (!isQueueRunning) {
            processNextSteamRequest();
        }

    }

    async function loadMorePages() {
        const statusDiv = document.getElementById('combine-status');

        // Находим кнопку и блокируем её, добавляя спиннер
        const btn = document.getElementById('start-combine');
        if (btn) {
            btn.disabled = true;
            btn.classList.add('lis-btn-disabled');
            btn.innerHTML = `<span class="lis-spinner"></span>Загрузка...`;
        }

        let pagesCount = parseInt(document.getElementById('pages-num-input').value) || 1;

        pagesCount = Math.min(pagesCount, 99);

        const gridContainer = document.querySelector('.skins-market-skins-list');
        if (!gridContainer) { statusDiv.innerText = "Ошибка сетки!"; return; }

        if (pagesCount <= 1) { applyDiffFilter(); statusDiv.innerText = "Фильтр 1-й стр."; return; }

        document.querySelectorAll('.item.loaded-by-script').forEach(el => el.remove());
        document.querySelectorAll('.skins-market-skins-list > .item').forEach(card => card.style.display = '');

        const baseUrl = window.location.origin + window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);

        for (let p = 2; p <= pagesCount; p++) {
            searchParams.set('page', p);
            const targetUrl = `${baseUrl}?${searchParams.toString()}`;
            statusDiv.innerText = `Загрузка страницы ${p}...`;

            try {
                const response = await fetch(targetUrl);
                if (!response.ok) throw new Error();
                const htmlText = await response.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, 'text/html');
                const remoteCards = doc.querySelectorAll('.skins-market-skins-list > .item');

                let addedInThisPage = 0;
                remoteCards.forEach(card => {
                    const clonedCard = card.cloneNode(true);
                    clonedCard.classList.add('loaded-by-script');
                    gridContainer.appendChild(clonedCard);
                    addedInThisPage++;
                });
                if (addedInThisPage === 0) break;
            } catch (err) { break; }
        }

        statusDiv.innerText = "Фильтрация...";

        applyDiffFilter();

        // Если страниц для обработки не оказалось (очередь пуста), разблокируем кнопку сразу здесь.
        // Если карточки есть, разблокировка произойдет в конце processNextSteamRequest.
        if (steamRequestsQueue.length === 0) {
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('lis-btn-disabled');
                btn.innerText = 'Загрузить и отфильтровать';
            }
            showSuccessToast('Фильтрация завершена. Нет подходящих карточек.');
        }

        statusDiv.innerText = `Готово!`;
    }

    const observer = new MutationObserver((mutations, obs) => {
        if (document.body && !panelInjected) {
            injectPanel();
            // ОПТИМИЗАЦИЯ: Отключаем observer, так как панель уже создана
            obs.disconnect();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
