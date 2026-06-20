// ==UserScript==
// @name         lis-skins-profit-calculator
// @namespace    http://tampermonkey.net
// @version      15.1
// @description  lis-skins-profit-calculator
// @author       p0pye + AI Helper
// @match        https://lis-skins.com/*/market/*
// @icon         https://www.google.com/s2/favicons?domain=lis-skins.com&sz=64
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let panelInjected = false;
    let steamRequestsQueue = []; // Массив для хранения очереди задач
    const steamCache = new Map();
    let isQueueRunning = false; // Флаг, запущен ли процесс обработки
    let currentOperation = null;
    let operationId = 0;
    const STEAM_SELLER_MULTIPLIER = 1.15;
    const STEAM_REQUEST_TIMEOUT_MS = 20000;
    const LIS_PAGE_REQUEST_TIMEOUT_MS = 20000;
    const MAX_STEAM_429_REQUEUES = 10;
    const STEAM_CACHE_TTL_MS = 5 * 60 * 1000;

    function createOperation() {
        currentOperation = {
            id: ++operationId,
            cancelled: false,
            steamRetryCount: 0,
            steamPausePromise: null,
            cleanups: new Set()
        };
        return currentOperation;
    }

    function isOperationActive(operation) {
        return operation && currentOperation === operation && !operation.cancelled;
    }

    function setStartButtonLoading(isLoading) {
        const btn = document.getElementById('start-combine');
        if (!btn) return;

        btn.disabled = false;
        if (isLoading) {
            btn.classList.remove('lis-btn-disabled');
            btn.classList.add('lis-btn-cancel');
            btn.innerHTML = `<span class="lis-spinner"></span>Отмена`;
        } else {
            btn.classList.remove('lis-btn-disabled', 'lis-btn-cancel');
            btn.innerText = 'Найти выгодные';
        }
    }

    function finishOperation(operation, statusText = '') {
        if (currentOperation !== operation) return;

        currentOperation = null;
        isQueueRunning = false;
        steamRequestsQueue = [];
        setStartButtonLoading(false);

        const statusDiv = document.getElementById('combine-status');
        if (statusDiv && statusText) statusDiv.innerText = statusText;
    }

    function cancelCurrentOperation() {
        const operation = currentOperation;
        if (!operation) return false;

        sortCardsByProfit();
        operation.cancelled = true;
        steamRequestsQueue = [];
        operation.cleanups.forEach(cleanup => cleanup());
        operation.cleanups.clear();
        finishOperation(operation, 'Отменено.');
        return true;
    }

    function resetAnalysisResults() {
        document.querySelectorAll('.steam-highest-buy-order-link[data-lis-helper-badge="true"]').forEach(badge => badge.remove());
        document.querySelectorAll('.skins-market-skins-list > .item.loaded-by-script').forEach(card => card.remove());
        document.querySelectorAll('.skins-market-skins-list > .item').forEach(card => {
            card.removeAttribute('data-calculated-profit');
            card.style.display = '';
        });
    }

    function waitForOperation(operation, delay, onTick = null) {
        if (!isOperationActive(operation)) return Promise.resolve();

        return new Promise(resolve => {
            let finished = false;
            const startedAt = Date.now();
            const finish = () => {
                if (finished) return;
                finished = true;
                operation.cleanups.delete(cleanup);
                clearTimeout(timerId);
                if (intervalId) clearInterval(intervalId);
                resolve();
            };

            const tick = () => {
                if (!onTick || !isOperationActive(operation)) return;

                const remainingMs = Math.max(delay - (Date.now() - startedAt), 0);
                onTick(Math.ceil(remainingMs / 1000));
            };

            const timerId = setTimeout(finish, delay);
            const intervalId = onTick ? setInterval(tick, 1000) : null;

            const cleanup = () => {
                finish();
            };

            operation.cleanups.add(cleanup);
            tick();
        });
    }

    function updateSteamProgress(operation, prefix = 'Загрузка цен Steam') {
        if (!isOperationActive(operation) || !operation.steamProgress) return;

        const statusDiv = document.getElementById('combine-status');
        if (!statusDiv) return;

        const total = operation.steamProgress.total;
        const completed = operation.steamProgress.completed;
        const current = Math.min(completed + 1, total);
        const remaining = Math.max(total - completed, 0);
        const elapsedMs = Date.now() - operation.steamProgress.startedAt;
        const etaText = completed > 0 && remaining > 0
            ? `, примерно ${formatDuration((elapsedMs / completed) * remaining)}`
            : '';

        statusDiv.innerText = `${prefix}: ${current}/${total}, осталось ${remaining}${etaText}`;
    }

    function completeSteamTask(operation) {
        operation.steamProgress.completed++;

        if (operation.steamProgress.completed % 10 === 0) {
            sortCardsByProfit(false);
        }

        updateSteamProgress(operation);
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(Math.ceil(milliseconds / 1000), 0);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes <= 0) return `${seconds}с`;
        return `${minutes}м ${seconds.toString().padStart(2, '0')}с`;
    }

    function pauseSteamGlobally(operation) {
        if (operation.steamPausePromise) return operation.steamPausePromise;

        operation.steamRetryCount++;
        const retryDelay = 60000 + ((operation.steamRetryCount - 1) * 30000);
        operation.steamPausePromise = waitForOperation(operation, retryDelay, (secondsLeft) => {
            updateSteamProgress(operation, `Steam Блок 429! Ретрай через ${secondsLeft}с. Цены Steam`);
        }).finally(() => {
            if (currentOperation === operation) operation.steamPausePromise = null;
        });

        return operation.steamPausePromise;
    }

    function getWorkersCount() {
        const input = document.getElementById('workers-num-input');
        let value = input ? parseInt(input.value) : parseInt(localStorage.getItem('lis_helper_workers_count'));

        if (!value || value < 1) value = 3;
        if (value > 7) value = 7;

        return value;
    }

    function getTooltipRowsCount() {
        const input = document.getElementById('tooltip-rows-num-input');
        let value = input ? parseInt(input.value) : parseInt(localStorage.getItem('lis_helper_tooltip_rows_count'));

        if (!value || value < 1) value = 3;
        if (value > 10) value = 10;

        return value;
    }

    function encodeSteamMarketHashName(marketHashName) {
        return encodeURIComponent(marketHashName).replace(/[!'()*|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    }

    function normalizeItemName(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function isValidPrice(value) {
        return Number.isFinite(value) && value > 0;
    }

    function setCardPriceError(targetLinkElement, totalCard, message) {
        targetLinkElement.innerText = message;
        targetLinkElement.style.background = '#f04747';
        totalCard.setAttribute('data-calculated-profit', -999999);
        setSteamBreakdown(targetLinkElement);
    }

    function setCardNoBuyOrders(targetLinkElement, totalCard) {
        targetLinkElement.innerText = 'Нет заявок';
        targetLinkElement.style.background = '#607d8b';
        totalCard.setAttribute('data-calculated-profit', -999999);
        setSteamBreakdown(targetLinkElement);
    }

    function getSteamCacheKey(appId, marketHashName) {
        return `${appId}:${marketHashName}`;
    }

    function getFreshSteamCache(cacheKey) {
        const cached = steamCache.get(cacheKey);
        if (!cached) return null;

        if (!Number.isFinite(cached.fetchedAt) || Date.now() - cached.fetchedAt >= STEAM_CACHE_TTL_MS) {
            steamCache.delete(cacheKey);
            return null;
        }

        return cached;
    }

    function findCsWearText(totalCard) {
        const wearMatch = normalizeItemName(totalCard.textContent).match(/\b(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\b/i);
        return wearMatch ? wearMatch[1] : '';
    }

    function getMarketHashNameFromCard(totalCard) {
        const candidates = [];
        const addCandidate = (value) => {
            const normalized = normalizeItemName(value);
            if (normalized) candidates.push(normalized);
        };

        ['data-market-hash-name', 'data-name', 'data-title'].forEach(attr => addCandidate(totalCard.getAttribute(attr)));

        totalCard.querySelectorAll('[data-market-hash-name], [data-name], [data-title], img[alt], img[title], a[title]').forEach(element => {
            ['data-market-hash-name', 'data-name', 'data-title', 'alt', 'title'].forEach(attr => addCandidate(element.getAttribute(attr)));
        });

        const titleElem = totalCard.querySelector('.name, .item-name, .inner-name');
        addCandidate(titleElem ? titleElem.textContent : '');

        const wearPattern = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;
        let itemName = candidates.find(candidate => wearPattern.test(candidate)) || candidates.sort((a, b) => b.length - a.length)[0] || '';
        const wearText = findCsWearText(totalCard);

        if (wearText && itemName && !wearPattern.test(itemName)) {
            itemName = `${itemName} (${wearText})`;
        }

        return itemName;
    }

    function hasExplicitNoBuyOrdersMessage(doc) {
        const pageText = normalizeItemName(doc.body?.textContent || '').toLowerCase();
        const noOrdersMessages = [
            'нет активных заявок на покупку',
            'нет заявок на покупку',
            'заявок на покупку нет',
            'there are no active buy orders',
            'there are no buy orders',
            'no active buy orders',
            'keine aktiven kaufaufträge',
            'aucun ordre d’achat actif'
        ];

        return noOrdersMessages.some(message => pageText.includes(message));
    }

    function findBuyOrdersTable(labelElement) {
        const isTable = element => element?.matches?.('table');
        const findTableInside = element => element?.querySelector?.(':scope > table') || null;

        if (!labelElement) return null;

        let current = labelElement;
        for (let depth = 0; current && depth < 2; depth++, current = current.parentElement) {
            const sibling = current.nextElementSibling;
            if (isTable(sibling)) return sibling;

            const directTable = findTableInside(sibling);
            if (directTable) return directTable;
        }

        return null;
    }

    function getPriceTextFromBuyOrderLabel(element) {
        if (!element) return null;

        const descendants = Array.from(element.querySelectorAll('span, strong, b')).reverse();
        const currencyPattern = /(?:₽|\$|€|£|¥|₴|₸|₹|руб\.?|USD|EUR)/i;
        const withCurrency = descendants.find(candidate => {
            const text = normalizeItemName(candidate.textContent);
            return currencyPattern.test(text) && isValidPrice(parsePriceValue(text));
        });
        return withCurrency ? normalizeItemName(withCurrency.textContent) : '';
    }

    function getFirstOrderRowData(table) {
        if (!table) return null;

        const cells = table.querySelectorAll('tbody tr:first-child td');
        if (cells.length < 2) return null;

        const priceText = normalizeItemName(cells[0].textContent);
        if (!isValidPrice(parsePriceValue(priceText))) return null;

        return {
            priceText,
            ordersCount: cells[1].textContent.trim().replace(/\s| /g, '')
        };
    }

    function findSteamBuyOrders(doc) {
        const labelFragments = [
            'заявок на покупку по цене',
            'заявки на покупку по цене',
            'buy requests at',
            'buy orders at',
            'requests to buy at',
            'kaufaufträge zum preis',
            'ordres d’achat au prix',
            "ordres d'achat au prix",
            'órdenes de compra a',
            'ordini di acquisto a',
            'ofertas de compra a'
        ];

        const textElements = [];
        const walker = doc.createTreeWalker(doc.body, 4); // NodeFilter.SHOW_TEXT

        while (walker.nextNode()) {
            const textNode = walker.currentNode;
            const text = normalizeItemName(textNode.nodeValue).toLowerCase();
            if (!labelFragments.some(fragment => text.includes(fragment))) continue;

            const element = textNode.parentElement;
            if (element && !textElements.includes(element)) textElements.push(element);
        }

        for (const element of textElements) {
            const table = findBuyOrdersTable(element);
            const firstRow = getFirstOrderRowData(table);
            const priceText = getPriceTextFromBuyOrderLabel(element);

            if (isValidPrice(parsePriceValue(priceText))) {
                return {
                    priceText,
                    ordersCount: firstRow?.ordersCount || '',
                    table
                };
            }
        }

        return null;
    }

    async function processNextSteamRequest(operation) {
        if (isQueueRunning) return; // Предотвращаем повторный множественный запуск менеджера
        isQueueRunning = true;

        const concurrency = getWorkersCount(); // Количество одновременных запросов к Steam
        operation.steamProgress = {
            total: steamRequestsQueue.length,
            completed: 0,
            startedAt: Date.now()
        };
        updateSteamProgress(operation);

        // Функция-воркер, которая берет задачи из общей очереди
        const worker = async () => {
            while (steamRequestsQueue.length > 0 && isOperationActive(operation)) {
                if (operation.steamPausePromise) {
                    await operation.steamPausePromise;
                    continue;
                }

                const task = steamRequestsQueue.shift();
                if (!task) continue;
                updateSteamProgress(operation);

                // ШАГ 1: Проверка кэша. Если этот скин уже загружали — берем данные мгновенно
                const cacheKey = getSteamCacheKey(task.appId, task.marketHashName);
                const cached = getFreshSteamCache(cacheKey);
                if (cached) {
                    if (cached.status === 'no-orders') {
                        setCardNoBuyOrders(task.targetLinkElement, task.totalCard);
                        completeSteamTask(operation);
                        continue;
                    }

                    const lisPrice = parseFloat(task.targetLinkElement.getAttribute('data-lis-price')) || 0;
                    const steamPrice = parsePriceValue(cached.priceText);

                    if (!isValidPrice(lisPrice) || !isValidPrice(steamPrice)) {
                        steamCache.delete(cacheKey);
                        setCardPriceError(
                            task.targetLinkElement,
                            task.totalCard,
                            !isValidPrice(lisPrice) ? 'Ошибка цены LIS' : 'Ошибка цены Steam'
                        );
                        completeSteamTask(operation);
                        continue;
                    }

                    const calculatedProfit = calculateNetProfit(steamPrice, lisPrice);
                    const breakdownRows = calculateSteamBreakdownRows(cached.steamOrderRows, lisPrice);

                    task.targetLinkElement.innerText = formatPriceWithProfit(cached.priceText, task.targetLinkElement, cached.ordersCount);
                    task.totalCard.setAttribute('data-calculated-profit', calculatedProfit);
                    setSteamBreakdown(task.targetLinkElement, breakdownRows);
                    applyProfitBadgeColor(task.targetLinkElement, calculatedProfit);
                    completeSteamTask(operation);

                    continue;
                }

                // ШАГ 2: Если в кэше нет — отправляем сетевой запрос
                task.targetLinkElement.innerText = 'Загрузка...';

                await new Promise((resolve) => {
                    let completed = false;
                    const finishTask = async (status, data) => {
                        if (completed) return;
                        completed = true;
                        operation.cleanups.delete(cleanup);

                        if (!isOperationActive(operation)) {
                            resolve();
                            return;
                        }

                        if (status === 429) {
                            task.retry429Count = (task.retry429Count || 0) + 1;

                            if (task.retry429Count <= MAX_STEAM_429_REQUEUES) {
                                steamRequestsQueue.unshift(task);
                                task.targetLinkElement.innerText = `Пауза 429 (${task.retry429Count}/${MAX_STEAM_429_REQUEUES})`;
                                task.targetLinkElement.style.background = '#7289da';
                                sortCardsByProfit();
                                await pauseSteamGlobally(operation);
                            } else {
                                console.error(`[Profit Calculator Error] Достигнут лимит повторов 429 для "${task.marketHashName}"`);
                                task.targetLinkElement.innerText = 'Лимит 429 исчерпан';
                                task.targetLinkElement.style.background = '#f04747';
                                task.totalCard.setAttribute('data-calculated-profit', -999999);
                                completeSteamTask(operation);
                            }
                            resolve();
                        } else {
                            // Сохраняем успешный результат в кэш, чтобы не запрашивать повторно дубликаты
                            if (status === 200 && data) {
                                steamCache.set(cacheKey, {
                                    ...data,
                                    fetchedAt: Date.now()
                                });
                            }
                            // Безопасная, но ускоренная пауза между запросами в одном потоке (1.2 - 2 секунды)
                            const delay = 1200 + Math.random() * 800;
                            await waitForOperation(operation, delay);
                            completeSteamTask(operation);
                            resolve();
                        }
                    };

                    const request = fetchSteamPriceFromHTML(task.targetUrl, task.marketHashName, task.targetLinkElement, task.totalCard, operation, finishTask);
                    const cleanup = () => {
                        if (completed) return;
                        completed = true;
                        if (request && typeof request.abort === 'function') request.abort();
                        resolve();
                    };
                    operation.cleanups.add(cleanup);
                });
            }
        };

        // Запускаем параллельных воркера из одного пула задач
        const workers = Array(concurrency).fill(null).map(() => worker());
        // Ждем, пока абсолютно все воркеры закончат работу с пулом задач
        await Promise.all(workers);

        if (!isOperationActive(operation)) return;

        // Железно вызываем сортировку один раз, когда всё гарантированно готово
        sortCardsByProfit();

        // Выводим всплывающее уведомление об успешном окончании
        showSuccessToast('Обработка завершена!');

        finishOperation(operation);
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
        toast.innerText = `⚠️ Profit Calculator ${message}`;
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
        toast.innerHTML = `✅ Profit Calculator: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 5000);
    }

    // Инициализация и отрисовка боковой панели управления
    function shouldInjectPanel() {
        return Boolean(document.querySelector('.skins-market-skins-list > .item'));
    }

    function injectPanel() {
        if (panelInjected || document.getElementById('lis-helper-panel')) return;
        if (!shouldInjectPanel()) return;

        let style = document.getElementById('lis-helper-styles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'lis-helper-styles';
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
            .lis-btn-cancel {
                background: #f04747 !important;
                cursor: pointer !important;
            }
            .lis-panel-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 12px;
            }
            .lis-panel-title {
                flex: 1;
                color: #ff9800;
                font-weight: bold;
                text-align: center;
                white-space: nowrap;
            }
            .lis-panel-toggle {
                width: 24px;
                height: 24px;
                padding: 0;
                border: 1px solid #4f545c;
                border-radius: 4px;
                background: #36393e;
                color: #fff;
                cursor: pointer;
                font-family: Arial, "Helvetica Neue", sans-serif;
                font-size: 14px;
                line-height: 22px;
            }
            .lis-panel-toggle:hover {
                background: #4f545c;
            }
            #lis-helper-panel[data-collapsed="true"] {
                left: 0 !important;
                right: auto !important;
                width: 28px !important;
                min-width: 28px !important;
                padding: 7px 3px !important;
                border-radius: 0 8px 8px 0 !important;
                box-sizing: border-box !important;
                cursor: pointer !important;
            }
            #lis-helper-panel[data-collapsed="true"] .lis-panel-header {
                flex-direction: column;
                justify-content: flex-start;
                gap: 6px;
                margin-bottom: 0;
            }
            #lis-helper-panel[data-collapsed="true"] .lis-panel-title {
                order: 2;
                writing-mode: vertical-rl;
                transform: rotate(180deg);
                text-align: left;
                line-height: 1;
            }
            #lis-helper-panel[data-collapsed="true"] .lis-panel-toggle {
                order: 1;
                width: 20px;
                min-width: 20px;
                height: 20px;
                font-size: 12px;
                line-height: 18px;
            }
            #lis-helper-panel[data-collapsed="true"] .lis-panel-content {
                display: none !important;
            }
            .lis-number-control {
                display: flex;
                align-items: stretch;
                gap: 3px;
            }
            .lis-setting-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto auto;
                align-items: center;
                gap: 5px;
                margin-bottom: 5px;
            }
            .lis-setting-row label {
                line-height: 1.2;
            }
            .lis-stepper-buttons {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .lis-stepper {
                width: 18px;
                height: 13px;
                padding: 0;
                border: 1px solid #4f545c;
                border-radius: 3px;
                background: #36393e;
                color: #fff;
                cursor: pointer;
                font-size: 8px;
                line-height: 10px;
            }
            .lis-stepper:hover {
                background: #4f545c;
            }
            .lis-help {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: #36393e;
                border: 1px solid #4f545c;
                color: #fff;
                font-size: 10px;
                font-weight: bold;
                cursor: help;
                line-height: 1;
            }
            .lis-help:hover::after {
                content: attr(data-tooltip);
                position: absolute;
                right: 18px;
                top: 50%;
                transform: translateY(-50%);
                width: 170px;
                padding: 7px 9px;
                border-radius: 5px;
                background: #111318;
                border: 1px solid #4f545c;
                color: #fff;
                font-size: 12px;
                font-weight: normal;
                line-height: 1.3;
                box-shadow: 0 4px 12px rgba(0,0,0,0.45);
                z-index: 10000001;
                pointer-events: none;
            }
            .lis-profit-tooltip {
                position: fixed;
                z-index: 10000000;
                background: #1e2124;
                color: #fff;
                border: 1px solid #4f545c;
                border-radius: 6px;
                box-shadow: 0 6px 18px rgba(0,0,0,0.55);
                padding: 8px;
                font-family: Arial, "Helvetica Neue", sans-serif;
                font-size: 11px;
                pointer-events: auto;
                width: min(760px, calc(100vw - 16px));
                box-sizing: border-box;
                overflow: hidden;
            }
            .lis-profit-tooltip table {
                border-collapse: collapse;
                width: 100%;
                table-layout: fixed;
            }
            .lis-profit-tooltip th,
            .lis-profit-tooltip td {
                border: 1px solid #4f545c;
                padding: 4px 6px;
                text-align: right;
                overflow-wrap: anywhere;
            }
            .lis-profit-tooltip th {
                color: #ff9800;
                font-weight: bold;
                line-height: 1.2;
                text-align: center;
            }
            .lis-profit-tooltip td {
                white-space: nowrap;
            }
            .lis-profit-cell-positive {
                background: #2e8b57;
                color: #fff;
            }
            .lis-profit-cell-negative {
                background: #bd362f;
                color: #fff;
            }
            `;
            document.head.appendChild(style);
        }

        const savedDiff = localStorage.getItem('lis_helper_min_diff') || '0';
        const savedPages = localStorage.getItem('lis_helper_pages_count') || '2';
        const savedWorkers = localStorage.getItem('lis_helper_workers_count') || '3';
        const savedTooltipRows = localStorage.getItem('lis_helper_tooltip_rows_count') || '3';

        const panel = document.createElement('div');
        panel.id = 'lis-helper-panel';
        const initiallyCollapsed = localStorage.getItem('lis_helper_panel_collapsed') === '1';
        panel.setAttribute('data-collapsed', String(initiallyCollapsed));
        panel.style = `
            position: fixed; top: 140px; left: 8px; z-index: 9999999 !important;
            background: #1e2124 !important; color: #fff !important; padding: 12px !important;
            border-radius: 8px !important; border: 1px solid #36393e !important;
            box-shadow: 0 4px 15px rgba(0,0,0,0.8) !important; font-family: sans-serif !important;
            font-size: 13px !important; width: 210px !important; display: block !important;
        `;

        panel.innerHTML = `
            <div class="lis-panel-header">
                <div class="lis-panel-title">Profit-Calculator</div>
                <button type="button" id="lis-panel-toggle" class="lis-panel-toggle" aria-label="Свернуть настройки" title="Свернуть настройки">◀</button>
            </div>

            <div class="lis-panel-content">
            <div class="lis-setting-row">
                <label>Мин. скидка (%):</label>
                <div class="lis-number-control">
                    <input type="number" id="diff-num-input" min="0" max="100" value="${savedDiff}" style="
                        width: 50px; background: #2f3136; color: #ff9800; border: 1px solid #4f545c;
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="diff-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="diff-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Показывать только карточки со скидкой не ниже этого процента.">?</span>
            </div>
            <input type="range" id="min-diff-input" min="0" max="80" value="${Math.min(parseInt(savedDiff), 80)}" step="1" style="
                width: 100%; margin-bottom: 15px; cursor: pointer; accent-color: #ff9800;
            ">

            <div class="lis-setting-row">
                <label>Страниц собрать:</label>
                <div class="lis-number-control">
                    <input type="number" id="pages-num-input" min="1" max="99" value="${savedPages}" style="
                        width: 50px; background: #2f3136; color: #7289da; border: 1px solid #4f545c;
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="pages-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="pages-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько страниц маркета загрузить перед фильтрацией.">?</span>
            </div>
            <input type="range" id="pages-to-load" min="1" max="99" value="${savedPages}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: #7289da;
            ">

            <div class="lis-setting-row">
                <label>Воркеров Steam:</label>
                <div class="lis-number-control">
                    <input type="number" id="workers-num-input" min="1" max="7" value="${Math.min(parseInt(savedWorkers), 7)}" style="
                        width: 50px; background: #2f3136; color: #43b581; border: 1px solid #4f545c;
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="workers-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="workers-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько запросов к Steam делать одновременно. Большое значение может вызвать временную блокировку.">?</span>
            </div>
            <input type="range" id="workers-to-load" min="1" max="7" value="${Math.min(parseInt(savedWorkers), 7)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: #43b581;
            ">

            <div class="lis-setting-row">
                <label>Лотов в подсказке:</label>
                <div class="lis-number-control">
                    <input type="number" id="tooltip-rows-num-input" min="1" max="10" value="${Math.min(parseInt(savedTooltipRows), 10)}" style="
                        width: 50px; background: #2f3136; color: #ff9800; border: 1px solid #4f545c;
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="tooltip-rows-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="tooltip-rows-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько строк Steam показать в таблице. Таблица появляется при наведении мышки на плашку цены.">?</span>
            </div>
            <input type="range" id="tooltip-rows-to-load" min="1" max="10" value="${Math.min(parseInt(savedTooltipRows), 10)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: #ff9800;
            ">

            <button id="start-combine" style="width: 100%; background: #43b581; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight: bold;">Найти выгодные</button>
            <div id="combine-status" style="margin-top: 8px; color: #aaa; font-size: 11px; text-align: center;"></div>
            </div>
        `;

        if (document.body) {
            document.body.appendChild(panel);
            panelInjected = true;

            const pagesSlider = document.getElementById('pages-to-load');
            const pagesNumber = document.getElementById('pages-num-input');
            const diffSlider = document.getElementById('min-diff-input');
            const diffNumber = document.getElementById('diff-num-input');
            const workersSlider = document.getElementById('workers-to-load');
            const workersNumber = document.getElementById('workers-num-input');
            const tooltipRowsSlider = document.getElementById('tooltip-rows-to-load');
            const tooltipRowsNumber = document.getElementById('tooltip-rows-num-input');
            const panelToggle = document.getElementById('lis-panel-toggle');

            const setPanelCollapsed = (collapsed) => {
                panel.setAttribute('data-collapsed', String(collapsed));
                panel.style.setProperty('left', collapsed ? '0' : '8px', 'important');
                panel.style.setProperty('right', 'auto', 'important');
                panel.style.setProperty('width', collapsed ? '28px' : '210px', 'important');
                panel.style.setProperty('min-width', collapsed ? '28px' : '0', 'important');
                panel.style.setProperty('padding', collapsed ? '7px 3px' : '12px', 'important');
                panel.style.setProperty('border-radius', collapsed ? '0 8px 8px 0' : '8px', 'important');
                panel.style.setProperty('box-sizing', 'border-box', 'important');
                panelToggle.innerText = collapsed ? '▶' : '◀';
                panelToggle.setAttribute('aria-label', collapsed ? 'Развернуть настройки' : 'Свернуть настройки');
                panelToggle.title = collapsed ? 'Развернуть настройки' : 'Свернуть настройки';
                localStorage.setItem('lis_helper_panel_collapsed', collapsed ? '1' : '0');
            };

            setPanelCollapsed(initiallyCollapsed);
            panelToggle.addEventListener('click', event => {
                event.stopPropagation();
                setPanelCollapsed(panel.getAttribute('data-collapsed') !== 'true');
            });
            panel.addEventListener('click', () => {
                if (panel.getAttribute('data-collapsed') === 'true') {
                    setPanelCollapsed(false);
                }
            });

            function stepInputValue(input, delta) {
                const min = parseInt(input.getAttribute('min')) || 0;
                const max = parseInt(input.getAttribute('max')) || 100;
                const step = parseInt(input.getAttribute('step')) || 1;
                let value = parseInt(input.value);
                if (isNaN(value)) value = min;

                value += delta * step;
                if (value > max) value = max;
                if (value < min) value = min;

                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }

            panel.querySelectorAll('.lis-stepper').forEach(button => {
                button.addEventListener('click', function() {
                    const input = document.getElementById(this.getAttribute('data-step-target'));
                    if (!input) return;

                    const delta = parseInt(this.getAttribute('data-step-delta')) || 0;
                    stepInputValue(input, delta);
                });
            });

            [diffNumber, diffSlider, pagesNumber, pagesSlider, workersNumber, workersSlider, tooltipRowsNumber, tooltipRowsSlider].forEach(input => {
                input.addEventListener('wheel', function(event) {
                    event.preventDefault();
                    stepInputValue(this, event.deltaY < 0 ? 1 : -1);
                }, { passive: false });
            });

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
            workersSlider.addEventListener('input', function() {
                workersNumber.value = this.value;
                localStorage.setItem('lis_helper_workers_count', this.value);
            });
            workersNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 3;
                if (val > 7) val = 7; if (val < 1) val = 1;
                this.value = val;
                workersSlider.value = val;
                localStorage.setItem('lis_helper_workers_count', val);
            });
            tooltipRowsSlider.addEventListener('input', function() {
                tooltipRowsNumber.value = this.value;
                localStorage.setItem('lis_helper_tooltip_rows_count', this.value);
            });
            tooltipRowsNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 3;
                if (val > 10) val = 10; if (val < 1) val = 1;
                this.value = val;
                tooltipRowsSlider.value = val;
                localStorage.setItem('lis_helper_tooltip_rows_count', val);
            });

            document.getElementById('start-combine').addEventListener('click', loadMorePages);
        }
    }

    // Парсинг цены автовыкупа на основе реальной DOM-структуры страницы Steam
    function fetchSteamPriceFromHTML(targetUrl, marketHashName, targetLinkElement, totalCard, operation, onComplete) {
        const requestUrl = new URL(targetUrl);
        requestUrl.searchParams.set('l', 'russian');

        const request = GM_xmlhttpRequest({
            method: "GET",
            url: requestUrl.toString(),
            timeout: STEAM_REQUEST_TIMEOUT_MS,
            onload: function(response) {
                if (!isOperationActive(operation)) {
                    if (onComplete) onComplete('cancelled');
                    return;
                }

                if (response.status === 429) {
                    if (onComplete) onComplete(429);
                    return;
                }

                if (response.status !== 200) {
                    console.error(`[Profit Calculator Error] Код ${response.status} для "${marketHashName}"`);
                    showErrorToast(`Steam заблокировал запрос (Код ${response.status}). Сделайте паузу.`);
                    targetLinkElement.innerText = `Блок ${response.status}`;
                    targetLinkElement.style.background = '#f04747';
                    // Передаем статус ошибки в колбэк, чтобы воркер корректно перешел к следующей задаче
                    if (onComplete) onComplete(response.status);
                    return;
                }
                try {
                    const htmlText = response.responseText;
                    const normalizedHtmlText = htmlText.replace(/\s+/g, ' ');
                    if (normalizedHtmlText.includes('За недавнее время вы отправили слишком много запросов. Повторите попытку позже.')) {
                        if (onComplete) onComplete(429);
                        return;
                    }

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    const buyOrders = findSteamBuyOrders(doc);
                    let priceFound = false;
                    if (buyOrders) {
                        const priceText = buyOrders.priceText;
                        const ordersCount = buyOrders.ordersCount;
                        const nextTable = buyOrders.table;
                        const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;
                        const steamOrderRows = getSteamOrderRows(nextTable);
                        const breakdownRows = calculateSteamBreakdownRows(steamOrderRows, lisPrice);

                        targetLinkElement.innerText = formatPriceWithProfit(priceText, targetLinkElement, ordersCount);
                        priceFound = true;

                        const steamPrice = parsePriceValue(priceText);

                        if (!isValidPrice(lisPrice) || !isValidPrice(steamPrice)) {
                            setCardPriceError(
                                targetLinkElement,
                                totalCard,
                                !isValidPrice(lisPrice) ? 'Ошибка цены LIS' : 'Ошибка цены Steam'
                            );
                            if (onComplete) onComplete('invalid-price');
                            return;
                        }

                        const calculatedProfit = calculateNetProfit(steamPrice, lisPrice);
                        totalCard.setAttribute('data-calculated-profit', calculatedProfit);
                        setSteamBreakdown(targetLinkElement, breakdownRows);
                        applyProfitBadgeColor(targetLinkElement, calculatedProfit);

                        // Кэшируем только исходные данные Steam. Прибыль и детализация
                        // зависят от цены конкретной карточки LIS и рассчитываются отдельно.
                        if (onComplete) onComplete(200, {
                            status: 'price',
                            priceText,
                            ordersCount,
                            steamOrderRows
                        });
                    }

                    if (!priceFound && hasExplicitNoBuyOrdersMessage(doc)) {
                        setCardNoBuyOrders(targetLinkElement, totalCard);
                        if (onComplete) onComplete(200, { status: 'no-orders' });

                        //console.Error(htmlText);
                    } else if (!priceFound) {
                        console.error(`[Profit Calculator Parser Error] Не удалось распознать данные Steam для "${marketHashName}"`);
                        targetLinkElement.innerText = "Ошибка ответа Steam";
                        targetLinkElement.style.background = '#f04747';
                        totalCard.setAttribute('data-calculated-profit', -999999);
                        if (onComplete) onComplete('parser-error');
                    }
                } catch (e) {
                    console.error(`[Profit Calculator Error] Сбой обработки DOM для "${marketHashName}":`, e);
                    targetLinkElement.innerText = "Ошибка структуры";
                    targetLinkElement.style.background = '#f04747';
                    // При ошибке структуры также уводим карточку вниз
                    totalCard.setAttribute('data-calculated-profit', -999999);
                    if (onComplete) onComplete('error');
                }

            },
            onerror: function(err) {
                if (!isOperationActive(operation)) {
                    if (onComplete) onComplete('cancelled');
                    return;
                }
                console.error(`[Profit Calculator Network Error] Сбой сети для "${marketHashName}":`, err);
                targetLinkElement.innerText = "Сбой сети";
                targetLinkElement.style.background = '#f04747';
                totalCard.setAttribute('data-calculated-profit', -999999);
                if (onComplete) onComplete('error');
            },
            ontimeout: function() {
                if (!isOperationActive(operation)) {
                    if (onComplete) onComplete('cancelled');
                    return;
                }
                console.error(`[Profit Calculator Timeout] Steam не ответил за ${STEAM_REQUEST_TIMEOUT_MS / 1000}с для "${marketHashName}"`);
                targetLinkElement.innerText = "Таймаут Steam";
                targetLinkElement.style.background = '#f04747';
                totalCard.setAttribute('data-calculated-profit', -999999);
                if (onComplete) onComplete('timeout');
            },
            onabort: function() {
                if (onComplete) onComplete('cancelled');
            }
        });

        return request;
    }

    // Вспомогательная функция для расчета чистой выгоды (Цена Steam - Цена LIS-SKINS)
    function formatPriceWithProfit(steamPriceRaw, targetLinkElement, ordersCount = '') {
        const steamPrice = parsePriceValue(steamPriceRaw);
        const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;

        if (!isValidPrice(steamPrice)) return 'Ошибка цены Steam';
        if (!isValidPrice(lisPrice)) return 'Ошибка цены LIS';

        // Формируем базовую строку цены и добавляем количество сделок (ордеров), если оно передано
        const ordersText = ordersCount ? ` [${ordersCount} шт.]` : '';
        let resultText = `${formatCurrency(steamPrice)}${ordersText}`;

        if (lisPrice > 0) {
            const profit = calculateNetProfit(steamPrice, lisPrice);
            const profitSign = profit > 0 ? '+' : '';
            const profitPercent = (profit / lisPrice) * 100;
            resultText += ` (${formatMoney(profit)}, ${profitSign}${profitPercent.toFixed(2)}%)`;
        }
        return resultText;
    }

    function parsePriceValue(text) {
        return parseFloat((text || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
    }

    function calculateSteamSale(steamPrice, lisPrice) {
        const netSale = steamPrice / STEAM_SELLER_MULTIPLIER;
        const commission = steamPrice - netSale;

        return {
            buyPrice: lisPrice,
            salePrice: steamPrice,
            grossProfit: steamPrice - lisPrice,
            commission,
            netSale,
            netProfit: netSale - lisPrice
        };
    }

    function calculateNetProfit(steamPrice, lisPrice) {
        return calculateSteamSale(steamPrice, lisPrice).netProfit;
    }

    function formatCurrency(value) {
        return new Intl.NumberFormat('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value) + ' ₽';
    }

    function formatMoney(value) {
        const sign = value > 0 ? '+' : '';
        return `${sign}${formatCurrency(value)}`;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getSteamOrderRows(table) {
        if (!table) return [];

        return Array.from(table.querySelectorAll('tbody tr')).slice(0, getTooltipRowsCount()).map(row => {
            const cells = row.querySelectorAll('td');
            const salePriceText = cells[0]?.textContent.trim() || '';
            const salePrice = parsePriceValue(salePriceText);
            const lotsCount = cells[1]?.textContent.trim().replace(/\s| /g, '') || '';

            if (!isValidPrice(salePrice)) return null;

            return {
                salePriceText,
                lotsCount,
                salePrice
            };
        }).filter(Boolean);
    }

    function calculateSteamBreakdownRows(steamOrderRows, lisPrice) {
        if (!Array.isArray(steamOrderRows) || lisPrice <= 0) return [];

        return steamOrderRows
            .filter(row => isValidPrice(row.salePrice))
            .map(row => ({
                salePriceText: row.salePriceText,
                lotsCount: row.lotsCount,
                ...calculateSteamSale(row.salePrice, lisPrice)
            }));
    }

    function setSteamBreakdown(badge, rows = []) {
        if (!rows || rows.length === 0) {
            badge.removeAttribute('data-steam-breakdown');
            return;
        }

        badge.setAttribute('data-steam-breakdown', JSON.stringify(rows));
    }

    function getProfitCellClass(value) {
        if (value > 0) return 'lis-profit-cell-positive';
        if (value < 0) return 'lis-profit-cell-negative';
        return '';
    }

    function buildBreakdownTooltipHtml(rows) {
        const bodyRows = rows.map(row => `
            <tr>
                <td>${formatCurrency(row.buyPrice)}</td>
                <td>${formatCurrency(row.salePrice)}</td>
                <td>${escapeHtml(row.lotsCount || '-')}</td>
                <td class="${getProfitCellClass(row.grossProfit)}">${formatMoney(row.grossProfit)}</td>
                <td>${formatCurrency(row.commission)}</td>
                <td>${formatCurrency(row.netSale)}</td>
                <td class="${getProfitCellClass(row.netProfit)}">${formatMoney(row.netProfit)}</td>
            </tr>
        `).join('');

        return `
            <table>
                <thead>
                    <tr>
                        <th>Цена покупки</th>
                        <th>Цена продажи</th>
                        <th>Лотов</th>
                        <th>Профит без комиссии</th>
                        <th>Сумма комиссии</th>
                        <th>Сумма зачисления</th>
                        <th>Профит</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        `;
    }

    function attachProfitTooltip(badge) {
        let hoverTimer = null;
        let hideTimer = null;
        let tooltip = null;

        const removeTooltip = () => {
            if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
            }
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            if (tooltip) {
                tooltip.remove();
                tooltip = null;
            }
        };

        const scheduleRemoveTooltip = () => {
            if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
            }
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(removeTooltip, 250);
        };

        badge.addEventListener('mouseenter', () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            if (tooltip) return;
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                const rowsRaw = badge.getAttribute('data-steam-breakdown');
                if (!rowsRaw) return;

                let rows;
                try {
                    rows = JSON.parse(rowsRaw);
                } catch (e) {
                    return;
                }
                if (!rows || rows.length === 0) return;

                const rect = badge.getBoundingClientRect();
                tooltip = document.createElement('div');
                tooltip.className = 'lis-profit-tooltip';
                tooltip.innerHTML = buildBreakdownTooltipHtml(rows);
                document.body.appendChild(tooltip);

                const tooltipRect = tooltip.getBoundingClientRect();
                const left = Math.min(rect.left, window.innerWidth - tooltipRect.width - 8);
                const top = rect.bottom + tooltipRect.height + 8 > window.innerHeight
                    ? rect.top - tooltipRect.height - 8
                    : rect.bottom + 8;

                tooltip.style.left = `${Math.max(left, 8)}px`;
                tooltip.style.top = `${Math.max(top, 8)}px`;
                tooltip.addEventListener('mouseenter', () => {
                    if (hideTimer) {
                        clearTimeout(hideTimer);
                        hideTimer = null;
                    }
                });
                tooltip.addEventListener('mouseleave', scheduleRemoveTooltip);
            }, 2000);
        });

        badge.addEventListener('mouseleave', scheduleRemoveTooltip);
        badge.addEventListener('click', removeTooltip);
    }

    function getValidProfit(card) {
        const profit = parseFloat(card.getAttribute('data-calculated-profit'));
        return Number.isFinite(profit) && profit > -999998 ? profit : null;
    }

    function getProfitPercentFromBadge(badge, profit) {
        const lisPrice = parseFloat(badge.getAttribute('data-lis-price')) || 0;
        return lisPrice > 0 && profit !== null ? (profit / lisPrice) * 100 : null;
    }

    function getProfitPercentFromCard(card) {
        const badge = card.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
        if (!badge) return null;

        const profit = getValidProfit(card);
        return getProfitPercentFromBadge(badge, profit);
    }

    function applyProfitBadgeColor(badge, profit) {
        const PROFITABLE_PERCENT_THRESHOLD = 20;
        const profitPercent = getProfitPercentFromBadge(badge, profit);

        if (badge.innerText === 'Загрузка...') {
            badge.style.background = '#7c5ce7';
        } else if (badge.innerText.startsWith('Пауза 429')) {
            badge.style.background = '#7289da';
        } else if (badge.innerText === 'Нет заявок') {
            badge.style.background = '#607d8b';
        } else if (badge.innerText.startsWith('Ошибка')) {
            badge.style.background = '#f04747';
        } else if (profit !== null && profit < 0) {
            badge.style.background = '#f04747';
        } else if (profitPercent !== null && profitPercent > PROFITABLE_PERCENT_THRESHOLD) {
            badge.style.background = '#43b581';
        } else {
            badge.style.background = '#ff9800';
        }
    }

    function updateProfitBadgeColors(cardsArray) {
        cardsArray.forEach(card => {
            const badge = card.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
            if (!badge) return;

            const profit = getValidProfit(card);
            applyProfitBadgeColor(badge, profit);
        });
    }

    // Функция сортировки карточек по значению выгоды (от большего к меньшему)
    function sortCardsByProfit(updateStatus = true) {
        const gridContainer = document.querySelector('.skins-market-skins-list');
        const statusDiv = document.getElementById('combine-status');
        if (!gridContainer) return;

        if (updateStatus && statusDiv) statusDiv.innerText = "Сортировка по выгоде...";

        // Получаем массив всех карточек
        const cardsArray = Array.from(gridContainer.querySelectorAll('.skins-market-skins-list > .item'));

        // Сортируем: карточки с большей выгодой идут вверх. Карточки без данных уходят вниз.
        cardsArray.sort((a, b) => {
            const profitPercentA = getProfitPercentFromCard(a);
            const profitPercentB = getProfitPercentFromCard(b);

            return (profitPercentB ?? -999998) - (profitPercentA ?? -999998);
        });

        // Перепривязываем элементы в DOM в новом порядке
        cardsArray.forEach(card => gridContainer.appendChild(card));
        updateProfitBadgeColors(cardsArray);

        if (updateStatus && statusDiv) statusDiv.innerText = "Готово! Отсортировано.";
    }

    function applyDiffFilter(operation) {
        if (!isOperationActive(operation)) return;

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
            let passesDiffFilter = minVal <= 0;

            if (elem && elem.hasAttribute('data-diff-value')) {
                const rawAttr = elem.getAttribute('data-diff-value') || '';
                const attrValue = parseFloat(rawAttr.replace('%', ''));
                passesDiffFilter = passesDiffFilter || (!isNaN(attrValue) && attrValue >= minVal);
            }

            if (passesDiffFilter) {
                totalCard.style.display = '';
                if (!totalCard.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]')) {
                    let itemName = getMarketHashNameFromCard(totalCard);

                    if (itemName) {
                        const steamLink = document.createElement('a');
                        steamLink.className = 'steam-highest-buy-order-link';
                        steamLink.setAttribute('data-lis-helper-badge', 'true');
                        steamLink.target = '_blank';
                        steamLink.style = `
                        position: absolute; top: 32px; left: 10px; right: 10px; z-index: 30;
                        background: #7c5ce7; color: #fff !important; padding: 3px 8px;
                        font-family: Arial, "Helvetica Neue", sans-serif;
                        font-size: 11px; font-weight: bold; border-radius: 4px;
                        text-decoration: none !important; box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                        display: block; box-sizing: border-box; line-height: 1.25;
                        white-space: normal; overflow-wrap: anywhere; text-align: left;
                        `;
                        steamLink.innerText = 'Загрузка...';
                        attachProfitTooltip(steamLink);

                        // Парсим цену самого скина на LIS-SKINS и сохраняем в дата-атрибут ссылки
                        const lisPriceElem = totalCard.querySelector('.price');
                        const lisPrice = lisPriceElem ? parseFloat(lisPriceElem.innerText.replace(/[^0-9.,]/g, '').replace(',', '.')) : 0;
                        steamLink.setAttribute('data-lis-price', lisPrice);

                        if (!isValidPrice(lisPrice)) {
                            setCardPriceError(steamLink, totalCard, 'Ошибка цены LIS');
                            totalCard.appendChild(steamLink);
                            return;
                        }

                        const targetSteamUrl = `https://steamcommunity.com/market/listings/${currentAppId}/${encodeSteamMarketHashName(itemName)}`;
                        steamLink.setAttribute('href', targetSteamUrl);
                        totalCard.appendChild(steamLink);

                        // Добавляем задачу в очередь запросов
                        steamRequestsQueue.push({
                            targetUrl: targetSteamUrl,
                            appId: currentAppId,
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

        if (!isQueueRunning && isOperationActive(operation)) {
            processNextSteamRequest(operation);
        }

    }

    async function loadMorePages() {
        if (currentOperation) {
            cancelCurrentOperation();
            return;
        }

        const operation = createOperation();
        const statusDiv = document.getElementById('combine-status');

        setStartButtonLoading(true);
        resetAnalysisResults();

        let pagesCount = parseInt(document.getElementById('pages-num-input').value) || 1;

        pagesCount = Math.min(pagesCount, 99);

        const gridContainer = document.querySelector('.skins-market-skins-list');
        if (!gridContainer) {
            finishOperation(operation, "Ошибка сетки!");
            return;
        }

        if (pagesCount <= 1) {
            applyDiffFilter(operation);
            if (isOperationActive(operation)) statusDiv.innerText = "Фильтр 1-й стр.";
            return;
        }

        const baseUrl = window.location.origin + window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);

        for (let p = 2; p <= pagesCount; p++) {
            searchParams.set('page', p);
            const targetUrl = `${baseUrl}?${searchParams.toString()}`;
            if (!isOperationActive(operation)) return;
            statusDiv.innerText = `Загрузка страницы ${p}/${pagesCount}, осталось ${pagesCount - p}`;

            let cleanup = null;
            let requestTimedOut = false;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    requestTimedOut = true;
                    controller.abort();
                }, LIS_PAGE_REQUEST_TIMEOUT_MS);
                cleanup = () => {
                    clearTimeout(timeoutId);
                    controller.abort();
                };
                operation.cleanups.add(cleanup);

                const response = await fetch(targetUrl, { signal: controller.signal });
                if (!isOperationActive(operation)) return;

                if (!response.ok) throw new Error();
                const htmlText = await response.text();
                clearTimeout(timeoutId);
                operation.cleanups.delete(cleanup);
                if (!isOperationActive(operation)) return;

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
            } catch (err) {
                if (cleanup) {
                    cleanup();
                    operation.cleanups.delete(cleanup);
                }
                if (!isOperationActive(operation)) return;

                if (requestTimedOut) {
                    showErrorToast(`Страница ${p} LIS не ответила за ${LIS_PAGE_REQUEST_TIMEOUT_MS / 1000} секунд.`);
                    statusDiv.innerText = `Таймаут при загрузке страницы ${p}. Обрабатываем уже загруженные.`;
                } else {
                    showErrorToast(`Не удалось загрузить страницу ${p} LIS.`);
                    statusDiv.innerText = `Ошибка загрузки страницы ${p}. Обрабатываем уже загруженные.`;
                }
                break;
            }
        }

        if (!isOperationActive(operation)) return;
        statusDiv.innerText = "Фильтрация...";

        applyDiffFilter(operation);

        // Если страниц для обработки не оказалось (очередь пуста), разблокируем кнопку сразу здесь.
        // Если карточки есть, разблокировка произойдет в конце processNextSteamRequest.
        if (steamRequestsQueue.length === 0) {
            finishOperation(operation, 'Готово!');
            showSuccessToast('Фильтрация завершена. Нет подходящих карточек.');
        } else if (isOperationActive(operation)) {
            statusDiv.innerText = `Загрузка цен Steam...`;
        }
    }

    const observer = new MutationObserver(() => {
        if (!document.getElementById('lis-helper-panel')) {
            panelInjected = false;
            injectPanel();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
