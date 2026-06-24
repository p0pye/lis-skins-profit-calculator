// ==UserScript==
// @name         lis-skins-profit-calculator
// @namespace    http://tampermonkey.net
// @version      15.2
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
    let steamRequestsQueue = [];
    const steamCache = new Map();
    let isQueueRunning = false;
    let currentOperation = null;
    let operationId = 0;
    const STEAM_FEE_RATE = 0.05;
    const STEAM_GAME_FEE_RATE = 0.10;
    const STEAM_REQUEST_TIMEOUT_MS = 20000;
    const LIS_PAGE_REQUEST_TIMEOUT_MS = 20000;
    const LIS_PAGE_MAX_RETRIES = 2;
    const LIS_PAGE_RETRY_DELAY_MS = 1000;
    const MAX_STEAM_429_REQUEUES = 10;
    const STEAM_CACHE_TTL_MS = 5 * 60 * 1000;
    const MAX_STEAM_TOOLTIP_ROWS = 20;
    const LIS_EARLY_STEAM_PROCESS_CARD_THRESHOLD = 1000;
    const EXCELLENT_PROFIT_PERCENT_THRESHOLD = 30;
    const PROFITABLE_PERCENT_THRESHOLD = 20;
    const PROFIT_COLOR_EXCELLENT = '#16a34a';
    const PROFIT_COLOR_POSITIVE = '#10b981';
    const PROFIT_COLOR_NEUTRAL = '#f59e0b';
    const PROFIT_COLOR_NEGATIVE = '#dc2626';
    const COLOR_LOADING = '#2563eb';
    const COLOR_PAUSED = '#7c3aed';
    const COLOR_NO_ORDERS = '#64748b';
    const COLOR_TEXT = '#fff';
    const COLOR_PANEL_BG = '#111827';
    const COLOR_PANEL_FIELD_BG = '#1f2937';
    const COLOR_PANEL_HOVER = '#334155';
    const COLOR_PANEL_BORDER = '#475569';
    const COLOR_PANEL_ACCENT = '#38bdf8';
    const COLOR_PANEL_SECONDARY_ACCENT = '#a78bfa';
    const COLOR_PANEL_SUCCESS_ACCENT = '#22c55e';
    const COLOR_PANEL_STATUS = '#cbd5e1';
    const COLOR_TOOLTIP_BG = '#0f172a';
    const COLOR_ERROR_DARK = '#991b1b';
    const COLOR_SUCCESS_DARK = '#166534';
    const COLOR_SPINNER_TRACK = 'rgba(255,255,255,0.3)';
    const COLOR_SHADOW = 'rgba(0,0,0,0.5)';
    const COLOR_PANEL_SHADOW = 'rgba(0,0,0,0.8)';
    const COLOR_HELP_SHADOW = 'rgba(0,0,0,0.45)';
    const COLOR_TOOLTIP_SHADOW = 'rgba(0,0,0,0.55)';
    const COLOR_BADGE_SHADOW = 'rgba(0,0,0,0.3)';

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
            card.removeAttribute('data-calculated-profit-percent');
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

    function updateSteamProgress(operation, prefix = 'Steam') {
        if (!isOperationActive(operation) || !operation.steamProgress) return;

        const statusDiv = document.getElementById('combine-status');
        if (!statusDiv) return;

        const total = operation.steamProgress.total;
        const completed = operation.steamProgress.completed;
        const current = Math.min(completed + 1, total);
        const remaining = Math.max(total - completed, 0);
        const activePauseMs = operation.steamProgress.pauseStartedAt
            ? Date.now() - operation.steamProgress.pauseStartedAt
            : 0;
        const elapsedMs = Math.max(Date.now() - operation.steamProgress.startedAt - operation.steamProgress.pausedMs - activePauseMs, 0);
        const etaText = completed > 0 && remaining > 0
            ? `, примерно ${formatDuration((elapsedMs / completed) * remaining)}`
            : '';

        statusDiv.innerText = `${prefix}: ${current}/${total}, осталось ${remaining}${etaText}`;
    }

    function completeSteamTask(operation) {
        operation.steamProgress.completed++;

        if (operation.steamProgress.completed % operation.steamProgress.sortEvery === 0) {
            sortCardsByProfit(false);
        }

        updateSteamProgress(operation);
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(Math.ceil(milliseconds / 1000), 0);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes <= 0) return `${seconds} сек`;
        return `${minutes} мин ${seconds} сек`;
    }

    function updateLisProgress(operation) {
        if (!isOperationActive(operation) || !operation.lisProgress) return;

        const statusDiv = document.getElementById('combine-status');
        if (!statusDiv) return;

        const total = operation.lisProgress.total;
        const completed = operation.lisProgress.completed;
        const currentPage = Math.min(completed + 2, operation.lisProgress.pagesCount);
        const remaining = Math.max(total - completed, 0);
        const elapsedMs = Date.now() - operation.lisProgress.startedAt;
        const etaText = completed > 0 && remaining > 0
            ? `, примерно ${formatDuration((elapsedMs / completed) * remaining)}`
            : '';

        statusDiv.innerText = `LIS: ${currentPage}/${operation.lisProgress.pagesCount}, осталось ${remaining}${etaText}`;
    }

    function pauseSteamGlobally(operation) {
        if (operation.steamPausePromise) return operation.steamPausePromise;

        operation.steamRetryCount++;
        const retryDelay = 60000 + ((operation.steamRetryCount - 1) * 30000);
        const pauseStartedAt = Date.now();
        if (operation.steamProgress) operation.steamProgress.pauseStartedAt = pauseStartedAt;

        operation.steamPausePromise = waitForOperation(operation, retryDelay, (secondsLeft) => {
            updateSteamProgress(operation, `Steam ограничил запросы. Повтор через ${secondsLeft} сек`);
        }).finally(() => {
            if (operation.steamProgress?.pauseStartedAt === pauseStartedAt) {
                operation.steamProgress.pausedMs += Date.now() - pauseStartedAt;
                operation.steamProgress.pauseStartedAt = null;
            }
            if (currentOperation === operation) operation.steamPausePromise = null;
        });

        return operation.steamPausePromise;
    }

    function getWorkersCount() {
        const input = document.getElementById('workers-num-input');
        let value = input ? parseInt(input.value) : parseInt(localStorage.getItem('lis_helper_workers_count'));

        if (!value || value < 1) value = 3;
        if (value > 33) value = 33;

        return value;
    }

    function getSteamSortBatchSize(workersCount) {
        return Math.max(10, Math.round((workersCount / 33) * 330));
    }

    function getLisPagesConcurrency() {
        const input = document.getElementById('lis-pages-workers-num-input');
        let value = input ? parseInt(input.value) : parseInt(localStorage.getItem('lis_helper_pages_workers_count'));

        if (!value || value < 1) value = 4;
        if (value > 33) value = 33;

        return value;
    }

    function getTooltipRowsCount() {
        const input = document.getElementById('tooltip-rows-num-input');
        let value = input ? parseInt(input.value) : parseInt(localStorage.getItem('lis_helper_tooltip_rows_count'));

        if (!value || value < 1) value = 3;
        if (value > 20) value = 20;

        return value;
    }

    function clampProfitDeleteThreshold(value) {
        let parsed = parseInt(value);

        if (!Number.isFinite(parsed)) parsed = -100;
        if (parsed < -100) parsed = -100;
        if (parsed > 30) parsed = 30;

        return parsed;
    }

    function getProfitDeleteThreshold() {
        const input = document.getElementById('profit-delete-threshold-num-input');
        const value = input ? input.value : localStorage.getItem('lis_helper_profit_delete_threshold');

        return clampProfitDeleteThreshold(value);
    }

    function encodeSteamMarketHashName(marketHashName) {
        return encodeURIComponent(marketHashName).replace(/[!'()*|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    }

    function normalizeItemName(value) {
        return (value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeSteamMarketHashName(marketHashName, appId) {
        let normalized = normalizeItemName(marketHashName);

        if (appId === 570) {
            normalized = normalized.replace(
                /^(.+?):\s*\d[\d\s,.]*\s+(Inscribed|Strange)\s+Gem$/i,
                '$2 $1 Gem'
            );

            return normalizeItemName(normalized);
        }

        if (appId !== 730) return normalized;

        normalized = normalized.replace(/\s+\(Not Painted\)$/i, '');
        normalized = normalized.replace(/^StatTrak™?\s+★\s+/i, '★ StatTrak™ ');
        normalized = normalized.replace(/^Souvenir\s+★\s+/i, '★ Souvenir ');
        normalized = normalized.replace(/^Souvenir\s+(.+\s+Souvenir\s+Package)$/i, '$1');

        normalized = normalized.replace(
            /\b(Gamma Doppler)\s+(Emerald|Phase\s*[1-4])(?=\s*(?:\(|$))/i,
            '$1'
        );
        normalized = normalized.replace(
            /\b(Doppler)\s+(Ruby|Sapphire|Black Pearl|Phase\s*[1-4])(?=\s*(?:\(|$))/i,
            '$1'
        );

        return normalizeItemName(normalized);
    }

    function getCsExteriorCategoryValue(exteriorText) {
        const exteriorCategories = {
            'factory new': 'WearCategory0',
            'minimal wear': 'WearCategory1',
            'field-tested': 'WearCategory2',
            'well-worn': 'WearCategory3',
            'battle-scarred': 'WearCategory4'
        };

        return exteriorCategories[normalizeItemName(exteriorText).toLowerCase()] || '';
    }

    function buildSteamListingUrl(appId, marketHashName, totalCard) {
        const url = new URL(`https://steamcommunity.com/market/listings/${appId}/${encodeSteamMarketHashName(marketHashName)}`);

        if (appId === 730) {
            const exteriorCategory = getCsExteriorCategoryValue(findCsExteriorText(totalCard));
            if (exteriorCategory) url.searchParams.set('category_Exterior', exteriorCategory);
        }

        return url.toString();
    }

    function isValidPrice(value) {
        return Number.isFinite(value) && value > 0;
    }

    function setCardPriceError(targetLinkElement, totalCard, message) {
        targetLinkElement.innerText = message;
        targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
        totalCard.setAttribute('data-calculated-profit', -999999);
        totalCard.removeAttribute('data-calculated-profit-percent');
        setSteamBreakdown(targetLinkElement);
    }

    function setCardNoBuyOrders(targetLinkElement, totalCard) {
        targetLinkElement.innerText = 'Нет заявок';
        targetLinkElement.style.setProperty('background', COLOR_NO_ORDERS, 'important');
        totalCard.setAttribute('data-calculated-profit', -999999);
        totalCard.removeAttribute('data-calculated-profit-percent');
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

    function findCsExteriorText(totalCard) {
        const cardText = normalizeItemName(totalCard.textContent);
        const fullWearMatch = cardText.match(/\b(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\b/i);
        if (fullWearMatch) return fullWearMatch[1];

        const wearAliases = {
            FN: 'Factory New',
            MW: 'Minimal Wear',
            FT: 'Field-Tested',
            WW: 'Well-Worn',
            BS: 'Battle-Scarred'
        };
        const shortWearMatch = cardText.match(/(?:^|[\s/|])(?:FN|MW|FT|WW|BS)(?=$|[\s/|])/i);
        if (!shortWearMatch) return '';

        return wearAliases[shortWearMatch[0].replace(/[\s/|]/g, '').toUpperCase()] || '';
    }

    function getMarketHashNameFromCard(totalCard, appId) {
        const rootCandidates = [];
        const nestedCandidates = [];
        const addCandidate = (target, value) => {
            const normalized = normalizeItemName(value);
            if (normalized) target.push(normalized);
        };

        ['data-market-hash-name', 'data-name', 'data-title'].forEach(attr => addCandidate(rootCandidates, totalCard.getAttribute(attr)));

        totalCard.querySelectorAll('[data-market-hash-name], [data-name], [data-title], img[alt], img[title], a[title]').forEach(element => {
            ['data-market-hash-name', 'data-name', 'data-title', 'alt', 'title'].forEach(attr => addCandidate(nestedCandidates, element.getAttribute(attr)));
        });

        const titleElem = totalCard.querySelector('.name, .item-name, .inner-name');
        const titleText = normalizeItemName(titleElem ? titleElem.textContent : '');

        const wearPattern = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;
        const allCandidates = [...rootCandidates, titleText, ...nestedCandidates].filter(Boolean);
        let itemName = allCandidates.find(candidate => wearPattern.test(candidate))
            || rootCandidates[0]
            || titleText
            || nestedCandidates.sort((a, b) => b.length - a.length)[0]
            || '';

        if (appId === 730) {
            const cardText = normalizeItemName(totalCard.textContent);
            const exteriorText = findCsExteriorText(totalCard);

            if (/(?:^|[\s/|])ST™?(?=$|[\s/|])|StatTrak™?/i.test(cardText) && !/^StatTrak™?\s+/i.test(itemName)) {
                itemName = `StatTrak™ ${itemName}`;
            } else if (/(?:^|[\s/|])Souvenir(?=$|[\s/|])/i.test(cardText) && !/^Souvenir\s+/i.test(itemName)) {
                itemName = `Souvenir ${itemName}`;
            }

            if (exteriorText && !wearPattern.test(itemName)) {
                itemName = `${itemName} (${exteriorText})`;
            }
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
            'нет предложений о продаже',
            'предмет недоступен',
            'запрашиваемый предмет, возможно, не существует',
            'не удалось загрузить этот контент',
            'не удалось найти этот предмет',
            'failed to load item description',
            'there was an error loading item data',
            'the item specified was not found',
            'there are no listings',
            'there are currently no listings',
            'no listings',
            'item not found',
            'item may not exist',
            'this item is unavailable',
            'keine aktiven kaufaufträge',
            'aucun ordre d’achat actif'
        ];

        return noOrdersMessages.some(message => pageText.includes(message));
    }

    function findBuyOrdersTable(labelElement) {
        const isTable = element => element?.matches?.('table');
        const findUsableTableInside = element => {
            if (!element?.querySelectorAll) return null;

            return Array.from(element.querySelectorAll('table')).find(isBuyOrdersTable) || null;
        };

        if (!labelElement) return null;

        let current = labelElement;
        for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
            if (isTable(current) && isBuyOrdersTable(current)) return current;

            const nestedTable = findUsableTableInside(current);
            if (nestedTable) return nestedTable;

            const sibling = current.nextElementSibling;
            if (isTable(sibling) && isBuyOrdersTable(sibling)) return sibling;

            const siblingTable = findUsableTableInside(sibling);
            if (siblingTable) return siblingTable;
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

    function parseBuyOrderSummaryText(text) {
        const normalized = normalizeItemName(text);
        const patterns = [
            {
                regex: /([\d][\d\s,.]*)\s+(?:requests?\s+to\s+buy|buy\s+requests?|buy\s+orders?)\s+at\s+(.+?)\s+(?:or\s+lower|or\s+less)/i,
                countIndex: 1,
                priceIndex: 2
            },
            {
                regex: /([\d][\d\s,.]*)\s+(?:заяв(?:ок|ки|ка)|запрос(?:ов|а)?)\s+на\s+покупку\s+(?:по\s+цене\s+)?(.+?)\s+(?:или\s+ниже|и\s+ниже|или\s+меньше)/i,
                countIndex: 1,
                priceIndex: 2
            },
            {
                regex: /(?:requests?\s+to\s+buy|buy\s+requests?|buy\s+orders?)\s+at\s+(.+?)\s+(?:or\s+lower|or\s+less)\s*:?\s*([\d][\d\s,.]*)/i,
                countIndex: 2,
                priceIndex: 1
            },
            {
                regex: /(?:заяв(?:ок|ки|ка)|запрос(?:ов|а)?)\s+на\s+покупку\s+(?:по\s+цене\s+)?(.+?)\s+(?:или\s+ниже|и\s+ниже|или\s+меньше)\s*:?\s*([\d][\d\s,.]*)/i,
                countIndex: 2,
                priceIndex: 1
            }
        ];

        for (const { regex, countIndex, priceIndex } of patterns) {
            const match = normalized.match(regex);
            if (!match) continue;

            const ordersCount = match[countIndex].replace(/\s| /g, '').replace(/[^\d.,]/g, '');
            const priceText = normalizeItemName(match[priceIndex]);
            const salePrice = parsePriceValue(priceText);
            if (!/\d/.test(ordersCount) || !isValidPrice(salePrice)) continue;

            return {
                priceText,
                ordersCount,
                isSummary: true
            };
        }

        return null;
    }

    function getSteamOrderRowsFromText(text) {
        const normalized = normalizeItemName(text);
        const tableStartMatch = normalized.match(/(?:Цена\s+Кол-?во|Price\s+Qty|Price\s+Quantity)/i);
        if (!tableStartMatch) return [];

        const tableText = normalized.slice(tableStartMatch.index + tableStartMatch[0].length);
        const pricePattern = '(?:[₽$€£¥₴₸₹]\\s*)?\\d[\\d\\s]*(?:[,.]\\d{1,2})?\\s*(?:руб\\.?|USD|EUR)?(?:\\s+(?:или|и)\\s+ниже)?';
        const rowPattern = new RegExp(`(${pricePattern})\\s+(\\d[\\d\\s,.]*?)(?=\\s+${pricePattern}|$)`, 'gi');
        const rows = [];

        for (const match of tableText.matchAll(rowPattern)) {
            const salePriceText = normalizeItemName(match[1]);
            const salePrice = parsePriceValue(salePriceText);
            const ordersCount = normalizeItemName(match[2]).replace(/\s| /g, '').replace(/[^\d.,]/g, '');

            if (!isValidPrice(salePrice) || !/\d/.test(ordersCount)) continue;

            rows.push({
                salePriceText,
                ordersCount,
                salePrice
            });

            if (rows.length >= MAX_STEAM_TOOLTIP_ROWS) break;
        }

        return rows;
    }

    function findBuyOrderRowsNearLabel(labelElement) {
        if (!labelElement) return [];

        let current = labelElement;
        for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
            const currentRows = getSteamOrderRowsFromText(current.textContent || '');
            if (currentRows.length > 0) return currentRows;

            const siblingRows = getSteamOrderRowsFromText(current.nextElementSibling?.textContent || '');
            if (siblingRows.length > 0) return siblingRows;
        }

        return [];
    }

    function isBuyOrdersTable(table) {
        if (!table) return false;

        const headerText = normalizeItemName(Array.from(table.querySelectorAll('thead th')).map(th => th.textContent).join(' ')).toLowerCase();
        const hasPriceHeader = /(?:цена|price)/i.test(headerText);
        const hasCountHeader = /(?:кол-?во|количество|qty|quantity)/i.test(headerText);

        return hasPriceHeader && hasCountHeader && getSteamOrderRows(table).length > 0;
    }

    function findBuyOrdersTableBySummary(doc, summary) {
        if (!doc || !summary) return null;

        const summaryPrice = parsePriceValue(summary.priceText);
        if (!isValidPrice(summaryPrice)) return null;

        return Array.from(doc.querySelectorAll('table')).find(table => {
            if (!isBuyOrdersTable(table)) return false;

            const firstRow = getFirstOrderRowData(table);
            if (!firstRow) return false;

            return Math.abs(parsePriceValue(firstRow.priceText) - summaryPrice) < 0.01;
        }) || null;
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
            const textRows = table ? [] : findBuyOrderRowsNearLabel(element);
            const firstRow = getFirstOrderRowData(table) || (textRows[0] ? {
                priceText: textRows[0].salePriceText,
                ordersCount: textRows[0].ordersCount
            } : null);
            const summary = parseBuyOrderSummaryText(element.textContent);
            const summaryTable = !table && summary ? findBuyOrdersTableBySummary(doc, summary) : null;
            const resolvedTable = table || summaryTable;
            const resolvedRows = resolvedTable ? [] : textRows;
            const resolvedFirstRow = getFirstOrderRowData(resolvedTable) || firstRow;
            const priceText = resolvedFirstRow?.priceText || summary?.priceText || getPriceTextFromBuyOrderLabel(element);

            if (isValidPrice(parsePriceValue(priceText))) {
                return {
                    priceText,
                    ordersCount: resolvedFirstRow?.ordersCount || summary?.ordersCount || '',
                    table: resolvedTable,
                    steamOrderRows: resolvedTable ? undefined : resolvedRows.length > 0 ? resolvedRows : undefined,
                    isSummary: !resolvedTable && resolvedRows.length === 0 && Boolean(summary?.isSummary)
                };
            }
        }

        return parseBuyOrderSummaryText(doc.body?.textContent || '');
    }

    function findSteamItemNameId(htmlText) {
        const patterns = [
            /Market_LoadOrderSpread\(\s*(\d+)\s*\)/,
            /LoadOrderSpread\(\s*(\d+)\s*\)/,
            /itemordershistogram\?[^"']*item_nameid=(\d+)/,
            /item_nameid[=:](\d+)/,
            /["']item_nameid["']\s*:\s*["']?(\d+)/,
            /\bitem_nameid\s*=\s*["']?(\d+)/
        ];

        for (const pattern of patterns) {
            const match = htmlText.match(pattern);
            if (match) return match[1];
        }

        return '';
    }

    function getSteamOrderRowsFromHistogram(buyOrderGraph) {
        if (!Array.isArray(buyOrderGraph)) return [];

        return buyOrderGraph.slice(0, MAX_STEAM_TOOLTIP_ROWS).map(row => {
            const salePrice = parsePriceValue(row?.[0]);
            const ordersCount = row?.[1] !== undefined ? String(row[1]).replace(/\s| /g, '') : '';

            if (!isValidPrice(salePrice)) return null;

            return {
                salePriceText: formatCurrency(salePrice),
                ordersCount,
                salePrice
            };
        }).filter(Boolean);
    }

    function findSteamBuyOrdersFromHistogram(histogram) {
        const steamOrderRows = getSteamOrderRowsFromHistogram(histogram?.buy_order_graph);
        const firstRow = steamOrderRows[0];
        if (!firstRow) return null;

        return {
            priceText: firstRow.salePriceText,
            ordersCount: firstRow.ordersCount,
            steamOrderRows
        };
    }

    function getSteamOrderRowsFromOrderBook(orderBook) {
        const compactBuyOrders = orderBook?.rgCompactBuyOrders;
        if (!Array.isArray(compactBuyOrders)) return [];

        const rows = [];
        for (let i = 0; i + 1 < compactBuyOrders.length && rows.length < MAX_STEAM_TOOLTIP_ROWS; i += 2) {
            const salePrice = Number(compactBuyOrders[i]) / 100;
            const ordersCount = String(compactBuyOrders[i + 1] ?? '').replace(/\s| /g, '');

            if (!isValidPrice(salePrice) || !/\d/.test(ordersCount)) continue;

            rows.push({
                salePriceText: formatCurrency(salePrice),
                ordersCount,
                salePrice
            });
        }

        return rows;
    }

    function findSteamBuyOrdersFromOrderBook(orderBook) {
        const steamOrderRows = getSteamOrderRowsFromOrderBook(orderBook);
        const firstRow = steamOrderRows[0];
        if (!firstRow) return null;

        return {
            priceText: firstRow.salePriceText,
            ordersCount: firstRow.ordersCount,
            steamOrderRows
        };
    }

    function fetchSteamOrderBook(appId, marketHashName, operation, onComplete) {
        const requestUrl = new URL('https://steamcommunity.com/market/orderbook');
        requestUrl.searchParams.set('q', 'Load');
        requestUrl.searchParams.set('qp', JSON.stringify([appId, marketHashName]));

        return GM_xmlhttpRequest({
            method: 'GET',
            url: requestUrl.toString(),
            timeout: STEAM_REQUEST_TIMEOUT_MS,
            headers: {
                'Accept': 'application/json',
                'x-valve-request-type': 'queryAction'
            },
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
                    if (onComplete) onComplete(response.status);
                    return;
                }

                try {
                    const orderBook = JSON.parse(response.responseText);
                    if (!orderBook?.success || !orderBook?.data) {
                        if (onComplete) onComplete('orderbook-error');
                        return;
                    }

                    const buyOrders = findSteamBuyOrdersFromOrderBook(orderBook.data);
                    if (onComplete) onComplete(200, buyOrders ? { status: 'price', buyOrders } : { status: 'no-orders' });
                } catch (e) {
                    if (onComplete) onComplete('orderbook-error');
                }
            },
            onerror: function() {
                if (onComplete) onComplete('error');
            },
            ontimeout: function() {
                if (onComplete) onComplete('timeout');
            },
            onabort: function() {
                if (onComplete) onComplete('cancelled');
            }
        });
    }

    function fetchSteamOrderHistogram(itemNameId, operation, onComplete) {
        const requestUrl = new URL('https://steamcommunity.com/market/itemordershistogram');
        requestUrl.searchParams.set('country', 'RU');
        requestUrl.searchParams.set('language', 'russian');
        requestUrl.searchParams.set('currency', '5');
        requestUrl.searchParams.set('item_nameid', itemNameId);
        requestUrl.searchParams.set('two_factor', '0');

        return GM_xmlhttpRequest({
            method: 'GET',
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
                    if (onComplete) onComplete(response.status);
                    return;
                }

                try {
                    const histogram = JSON.parse(response.responseText);
                    if (histogram?.success === 0) {
                        if (onComplete) onComplete('histogram-error');
                        return;
                    }

                    const buyOrders = findSteamBuyOrdersFromHistogram(histogram);
                    if (onComplete) onComplete(200, buyOrders ? { status: 'price', buyOrders } : { status: 'no-orders' });
                } catch (e) {
                    if (onComplete) onComplete('histogram-error');
                }
            },
            onerror: function() {
                if (onComplete) onComplete('error');
            },
            ontimeout: function() {
                if (onComplete) onComplete('timeout');
            },
            onabort: function() {
                if (onComplete) onComplete('cancelled');
            }
        });
    }

    function fetchSteamListingRender(targetUrl, operation, onComplete) {
        const listingUrl = new URL(targetUrl);
        const requestUrl = new URL(`${listingUrl.pathname.replace(/\/$/, '')}/render/`, listingUrl.origin);
        requestUrl.searchParams.set('query', '');
        requestUrl.searchParams.set('start', '0');
        requestUrl.searchParams.set('count', String(MAX_STEAM_TOOLTIP_ROWS));
        requestUrl.searchParams.set('country', 'RU');
        requestUrl.searchParams.set('language', 'russian');
        requestUrl.searchParams.set('currency', '5');

        return GM_xmlhttpRequest({
            method: 'GET',
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
                    if (onComplete) onComplete(response.status);
                    return;
                }

                try {
                    const data = JSON.parse(response.responseText);
                    if (data?.success === false || data?.success === 0) {
                        if (onComplete) onComplete('render-error');
                        return;
                    }

                    const buyOrders = findSteamBuyOrdersFromHistogram(data);
                    if (onComplete) onComplete(200, buyOrders ? { status: 'price', buyOrders } : { status: 'no-orders' });
                } catch (e) {
                    if (onComplete) onComplete('render-error');
                }
            },
            onerror: function() {
                if (onComplete) onComplete('error');
            },
            ontimeout: function() {
                if (onComplete) onComplete('timeout');
            },
            onabort: function() {
                if (onComplete) onComplete('cancelled');
            }
        });
    }

    async function processNextSteamRequest(operation, finalize = true) {
        if (isQueueRunning) return;
        isQueueRunning = true;

        const concurrency = getWorkersCount();
        operation.steamProgress = {
            total: steamRequestsQueue.length,
            completed: 0,
            startedAt: Date.now(),
            pausedMs: 0,
            pauseStartedAt: null,
            sortEvery: getSteamSortBatchSize(concurrency)
        };
        updateSteamProgress(operation);

        const worker = async () => {
            while (steamRequestsQueue.length > 0 && isOperationActive(operation)) {
                if (operation.steamPausePromise) {
                    await operation.steamPausePromise;
                    continue;
                }

                const task = steamRequestsQueue.shift();
                if (!task) continue;
                updateSteamProgress(operation);

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
                    setCardCalculatedProfit(task.totalCard, calculatedProfit, lisPrice);
                    setSteamBreakdown(task.targetLinkElement, breakdownRows);
                    applyProfitBadgeColor(task.targetLinkElement, calculatedProfit, getProfitPercentFromCard(task.totalCard));
                    removeCardBelowProfitThreshold(task.totalCard);
                    completeSteamTask(operation);

                    continue;
                }

                task.targetLinkElement.innerText = 'Загружаю';

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
                                task.targetLinkElement.innerText = `Пауза Steam ${task.retry429Count}/${MAX_STEAM_429_REQUEUES}`;
                                task.targetLinkElement.style.setProperty('background', COLOR_PAUSED, 'important');
                                sortCardsByProfit();
                                await pauseSteamGlobally(operation);
                            } else {
                                console.error(`[Profit Calculator Error] Достигнут лимит повторов 429 для "${task.marketHashName}"`);
                                task.targetLinkElement.innerText = 'Лимит повторов';
                                task.targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
                                task.totalCard.setAttribute('data-calculated-profit', -999999);
                                task.totalCard.removeAttribute('data-calculated-profit-percent');
                                completeSteamTask(operation);
                            }
                            resolve();
                        } else {
                            if (status === 200 && data) {
                                steamCache.set(cacheKey, {
                                    ...data,
                                    fetchedAt: Date.now()
                                });
                            }
                            const delay = 1200 + Math.random() * 800;
                            await waitForOperation(operation, delay);
                            completeSteamTask(operation);
                            resolve();
                        }
                    };

                    const request = fetchSteamPriceFromHTML(task.targetUrl, task.marketHashName, task.appId, task.targetLinkElement, task.totalCard, operation, finishTask);
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

        const workers = Array(concurrency).fill(null).map(() => worker());
        await Promise.all(workers);
        isQueueRunning = false;

        if (!isOperationActive(operation)) return;

        sortCardsByProfit(finalize);
        if (!finalize) {
            operation.steamProgress = null;
            return;
        }

        const summary = formatResultStats();
        showSuccessToast(summary);

        finishOperation(operation, summary);
    }

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
            background: ${PROFIT_COLOR_NEGATIVE}; color: ${COLOR_TEXT}; padding: 12px 18px; border-radius: 6px;
            font-family: sans-serif; font-size: 13px; font-weight: bold;
            box-shadow: 0 4px 12px ${COLOR_SHADOW}; border-left: 5px solid ${COLOR_ERROR_DARK};
            opacity: 1; transition: opacity 0.5s ease-in-out; min-width: 250px;
        `;
        toast.innerText = `⚠️ Profit-Calculator: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 10000);
    }

    function showSuccessToast(message) {
        let container = document.getElementById('lis-error-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'lis-error-toast-container';
            container.style = 'position: fixed; top: 20px; right: 20px; z-index: 99999999; display: flex; flex-direction: column; gap: 10px;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style = `
            background: ${PROFIT_COLOR_EXCELLENT}; color: ${COLOR_TEXT}; padding: 12px 18px; border-radius: 6px;
            font-family: sans-serif; font-size: 13px; font-weight: bold;
            box-shadow: 0 4px 12px ${COLOR_SHADOW}; border-left: 5px solid ${COLOR_SUCCESS_DARK};
            opacity: 1; transition: opacity 0.5s ease-in-out; min-width: 250px;
        `;
        toast.innerHTML = `✅ Profit-Calculator: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 5000);
    }

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
                border: 2px solid ${COLOR_SPINNER_TRACK};
                border-radius: 50%;
                border-top-color: ${COLOR_TEXT};
                animation: lis-spin 1s ease-in-out infinite;
                margin-right: 6px;
                vertical-align: middle;
            }
            .lis-btn-disabled {
                opacity: 0.6 !important;
                cursor: not-allowed !important;
                background: ${COLOR_PANEL_BORDER} !important;
            }
            .lis-btn-cancel {
                background: ${PROFIT_COLOR_NEGATIVE} !important;
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
                color: ${COLOR_PANEL_ACCENT};
                font-weight: bold;
                text-align: center;
                white-space: nowrap;
            }
            .lis-panel-toggle {
                width: 24px;
                height: 24px;
                padding: 0;
                border: 1px solid ${COLOR_PANEL_BORDER};
                border-radius: 4px;
                background: ${COLOR_PANEL_FIELD_BG};
                color: ${COLOR_TEXT};
                cursor: pointer;
                font-family: Arial, "Helvetica Neue", sans-serif;
                font-size: 14px;
                line-height: 22px;
            }
            .lis-panel-toggle:hover {
                background: ${COLOR_PANEL_HOVER};
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
                border: 1px solid ${COLOR_PANEL_BORDER};
                border-radius: 3px;
                background: ${COLOR_PANEL_FIELD_BG};
                color: ${COLOR_TEXT};
                cursor: pointer;
                font-size: 8px;
                line-height: 10px;
            }
            .lis-stepper:hover {
                background: ${COLOR_PANEL_HOVER};
            }
            .lis-help {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: ${COLOR_PANEL_FIELD_BG};
                border: 1px solid ${COLOR_PANEL_BORDER};
                color: ${COLOR_TEXT};
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
                background: ${COLOR_TOOLTIP_BG};
                border: 1px solid ${COLOR_PANEL_BORDER};
                color: ${COLOR_TEXT};
                font-size: 12px;
                font-weight: normal;
                line-height: 1.3;
                box-shadow: 0 4px 12px ${COLOR_HELP_SHADOW};
                z-index: 10000001;
                pointer-events: none;
            }
            .lis-profit-tooltip {
                position: fixed;
                z-index: 10000000;
                background: ${COLOR_PANEL_BG};
                color: ${COLOR_TEXT};
                border: 1px solid ${COLOR_PANEL_BORDER};
                border-radius: 6px;
                box-shadow: 0 6px 18px ${COLOR_TOOLTIP_SHADOW};
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
                border: 1px solid ${COLOR_PANEL_BORDER};
                padding: 4px 6px;
                text-align: right;
                overflow-wrap: anywhere;
            }
            .lis-profit-tooltip th {
                color: ${COLOR_PANEL_ACCENT};
                font-weight: bold;
                line-height: 1.2;
                text-align: center;
            }
            .lis-profit-tooltip td {
                white-space: nowrap;
            }
            .lis-profit-cell-excellent {
                background: ${PROFIT_COLOR_EXCELLENT};
                color: ${COLOR_TEXT};
            }
            .lis-profit-cell-good {
                background: ${PROFIT_COLOR_POSITIVE};
                color: ${COLOR_TEXT};
            }
            .lis-profit-cell-neutral {
                background: ${PROFIT_COLOR_NEUTRAL};
                color: ${COLOR_TEXT};
            }
            .lis-profit-cell-bad {
                background: ${PROFIT_COLOR_NEGATIVE};
                color: ${COLOR_TEXT};
            }
            `;
            document.head.appendChild(style);
        }

        const savedDiff = localStorage.getItem('lis_helper_min_diff') || '0';
        const savedPages = localStorage.getItem('lis_helper_pages_count') || '2';
        const savedLisPagesWorkers = localStorage.getItem('lis_helper_pages_workers_count') || '4';
        const savedWorkers = localStorage.getItem('lis_helper_workers_count') || '3';
        const savedTooltipRows = localStorage.getItem('lis_helper_tooltip_rows_count') || '3';
        const savedProfitDeleteThreshold = clampProfitDeleteThreshold(localStorage.getItem('lis_helper_profit_delete_threshold'));

        const panel = document.createElement('div');
        panel.id = 'lis-helper-panel';
        const initiallyCollapsed = localStorage.getItem('lis_helper_panel_collapsed') === '1';
        panel.setAttribute('data-collapsed', String(initiallyCollapsed));
        panel.style = `
            position: fixed; top: 140px; left: 8px; z-index: 9999999 !important;
            background: ${COLOR_PANEL_BG} !important; color: ${COLOR_TEXT} !important; padding: 12px !important;
            border-radius: 8px !important; border: 1px solid ${COLOR_PANEL_BORDER} !important;
            box-shadow: 0 4px 15px ${COLOR_PANEL_SHADOW} !important; font-family: sans-serif !important;
            font-size: 13px !important; width: 210px !important; display: block !important;
        `;

        panel.innerHTML = `
            <div class="lis-panel-header">
                <div class="lis-panel-title">Profit-Calculator</div>
                <button type="button" id="lis-panel-toggle" class="lis-panel-toggle" aria-label="Свернуть настройки" title="Свернуть настройки">◀</button>
            </div>

            <div class="lis-panel-content">
            <div class="lis-setting-row">
                <label>Скидка, от %:</label>
                <div class="lis-number-control">
                    <input type="number" id="diff-num-input" min="0" max="100" value="${savedDiff}" style="
                        width: 50px; background: ${COLOR_PANEL_FIELD_BG}; color: ${COLOR_PANEL_ACCENT}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="diff-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="diff-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Минимальная скидка на LIS. При 0 показываются все карточки.">?</span>
            </div>
            <input type="range" id="min-diff-input" min="0" max="80" value="${Math.min(parseInt(savedDiff), 80)}" step="1" style="
                width: 100%; margin-bottom: 15px; cursor: pointer; accent-color: ${COLOR_PANEL_ACCENT};
            ">

            <div class="lis-setting-row">
                <label>Страниц LIS:</label>
                <div class="lis-number-control">
                    <input type="number" id="pages-num-input" min="1" max="999" value="${Math.min(parseInt(savedPages), 999)}" style="
                        width: 60px; background: ${COLOR_PANEL_FIELD_BG}; color: ${COLOR_PANEL_SECONDARY_ACCENT}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="pages-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="pages-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько страниц LIS загрузить для поиска.">?</span>
            </div>
            <input type="range" id="pages-to-load" min="1" max="999" value="${Math.min(parseInt(savedPages), 999)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: ${COLOR_PANEL_SECONDARY_ACCENT};
            ">

            <div class="lis-setting-row">
                <label>Потоков LIS:</label>
                <div class="lis-number-control">
                    <input type="number" id="lis-pages-workers-num-input" min="1" max="33" value="${Math.min(parseInt(savedLisPagesWorkers), 33)}" style="
                        width: 50px; background: ${COLOR_PANEL_FIELD_BG}; color: ${PROFIT_COLOR_NEUTRAL}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="lis-pages-workers-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="lis-pages-workers-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько страниц LIS загружать одновременно. Высокое значение повышает нагрузку на сайт.">?</span>
            </div>
            <input type="range" id="lis-pages-workers-to-load" min="1" max="33" value="${Math.min(parseInt(savedLisPagesWorkers), 33)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: ${PROFIT_COLOR_NEUTRAL};
            ">

            <div class="lis-setting-row">
                <label>Запросов Steam:</label>
                <div class="lis-number-control">
                    <input type="number" id="workers-num-input" min="1" max="33" value="${Math.min(parseInt(savedWorkers), 33)}" style="
                        width: 50px; background: ${COLOR_PANEL_FIELD_BG}; color: ${COLOR_PANEL_SUCCESS_ACCENT}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="workers-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="workers-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько запросов к Steam делать одновременно. Высокое значение повышает риск блокировки.">?</span>
            </div>
            <input type="range" id="workers-to-load" min="1" max="33" value="${Math.min(parseInt(savedWorkers), 33)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: ${COLOR_PANEL_SUCCESS_ACCENT};
            ">

            <div class="lis-setting-row">
                <label>Мин. выгода, от %:</label>
                <div class="lis-number-control">
                    <input type="number" id="profit-delete-threshold-num-input" min="-100" max="30" value="${savedProfitDeleteThreshold}" style="
                        width: 50px; background: ${COLOR_PANEL_FIELD_BG}; color: ${PROFIT_COLOR_NEGATIVE}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="profit-delete-threshold-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="profit-delete-threshold-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="При сортировке удалять карточки, у которых выгода ниже этого процента.">?</span>
            </div>
            <input type="range" id="profit-delete-threshold-to-load" min="-100" max="30" value="${savedProfitDeleteThreshold}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: ${PROFIT_COLOR_NEGATIVE};
            ">

            <div class="lis-setting-row">
                <label>Строк в таблице:</label>
                <div class="lis-number-control">
                    <input type="number" id="tooltip-rows-num-input" min="1" max="20" value="${Math.min(parseInt(savedTooltipRows), 20)}" style="
                        width: 50px; background: ${COLOR_PANEL_FIELD_BG}; color: ${COLOR_PANEL_ACCENT}; border: 1px solid ${COLOR_PANEL_BORDER};
                        padding: 2px 4px; border-radius: 4px; font-weight: bold; text-align: center;
                    ">
                    <div class="lis-stepper-buttons">
                        <button type="button" class="lis-stepper" data-step-target="tooltip-rows-num-input" data-step-delta="1">▲</button>
                        <button type="button" class="lis-stepper" data-step-target="tooltip-rows-num-input" data-step-delta="-1">▼</button>
                    </div>
                </div>
                <span class="lis-help" data-tooltip="Сколько заявок Steam показывать в таблице при наведении на плашку.">?</span>
            </div>
            <input type="range" id="tooltip-rows-to-load" min="1" max="20" value="${Math.min(parseInt(savedTooltipRows), 20)}" style="
                width: 100%; margin-bottom: 20px; cursor: pointer; accent-color: ${COLOR_PANEL_ACCENT};
            ">

            <button id="start-combine" style="width: 100%; background: ${PROFIT_COLOR_EXCELLENT}; color: ${COLOR_TEXT}; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight: bold;">Найти выгодные</button>
            <div id="combine-status" style="margin-top: 8px; color: ${COLOR_PANEL_STATUS}; font-size: 11px; text-align: center;"></div>
            </div>
        `;

        if (document.body) {
            document.body.appendChild(panel);
            panelInjected = true;

            const pagesSlider = document.getElementById('pages-to-load');
            const pagesNumber = document.getElementById('pages-num-input');
            const lisPagesWorkersSlider = document.getElementById('lis-pages-workers-to-load');
            const lisPagesWorkersNumber = document.getElementById('lis-pages-workers-num-input');
            const diffSlider = document.getElementById('min-diff-input');
            const diffNumber = document.getElementById('diff-num-input');
            const workersSlider = document.getElementById('workers-to-load');
            const workersNumber = document.getElementById('workers-num-input');
            const profitDeleteThresholdSlider = document.getElementById('profit-delete-threshold-to-load');
            const profitDeleteThresholdNumber = document.getElementById('profit-delete-threshold-num-input');
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

            [diffNumber, diffSlider, pagesNumber, pagesSlider, lisPagesWorkersNumber, lisPagesWorkersSlider, workersNumber, workersSlider, profitDeleteThresholdNumber, profitDeleteThresholdSlider, tooltipRowsNumber, tooltipRowsSlider].forEach(input => {
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
                if (val > 999) val = 999; if (val < 1) val = 1;
                pagesSlider.value = val;
                localStorage.setItem('lis_helper_pages_count', val);
            });
            lisPagesWorkersSlider.addEventListener('input', function() {
                lisPagesWorkersNumber.value = this.value;
                localStorage.setItem('lis_helper_pages_workers_count', this.value);
            });
            lisPagesWorkersNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 4;
                if (val > 33) val = 33; if (val < 1) val = 1;
                this.value = val;
                lisPagesWorkersSlider.value = val;
                localStorage.setItem('lis_helper_pages_workers_count', val);
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
                if (val > 33) val = 33; if (val < 1) val = 1;
                this.value = val;
                workersSlider.value = val;
                localStorage.setItem('lis_helper_workers_count', val);
            });
            profitDeleteThresholdSlider.addEventListener('input', function() {
                profitDeleteThresholdNumber.value = this.value;
                localStorage.setItem('lis_helper_profit_delete_threshold', this.value);
            });
            profitDeleteThresholdNumber.addEventListener('input', function() {
                const val = clampProfitDeleteThreshold(this.value);
                this.value = val;
                profitDeleteThresholdSlider.value = val;
                localStorage.setItem('lis_helper_profit_delete_threshold', val);
            });
            tooltipRowsSlider.addEventListener('input', function() {
                tooltipRowsNumber.value = this.value;
                localStorage.setItem('lis_helper_tooltip_rows_count', this.value);
            });
            tooltipRowsNumber.addEventListener('input', function() {
                let val = parseInt(this.value) || 3;
                if (val > 20) val = 20; if (val < 1) val = 1;
                this.value = val;
                tooltipRowsSlider.value = val;
                localStorage.setItem('lis_helper_tooltip_rows_count', val);
            });

            document.getElementById('start-combine').addEventListener('click', loadMorePages);
        }
    }

    function fetchSteamPriceFromHTML(targetUrl, marketHashName, appId, targetLinkElement, totalCard, operation, onComplete) {
        const requestUrl = new URL(targetUrl);
        requestUrl.searchParams.set('l', 'russian');
        let pageRequest = null;
        let orderBookRequest = null;
        let histogramRequest = null;
        let renderRequest = null;

        const applySteamBuyOrders = (buyOrders) => {
            const priceText = buyOrders.priceText;
            const ordersCount = buyOrders.ordersCount;
            const nextTable = buyOrders.table;
            const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;
            const steamOrderRows = buyOrders.steamOrderRows || getSteamOrderRows(nextTable);
            const breakdownRows = calculateSteamBreakdownRows(steamOrderRows, lisPrice);

            targetLinkElement.innerText = formatPriceWithProfit(priceText, targetLinkElement, ordersCount);

            const steamPrice = parsePriceValue(priceText);

            if (!isValidPrice(lisPrice) || !isValidPrice(steamPrice)) {
                setCardPriceError(
                    targetLinkElement,
                    totalCard,
                    !isValidPrice(lisPrice) ? 'Ошибка цены LIS' : 'Ошибка цены Steam'
                );
                return false;
            }

            const calculatedProfit = calculateNetProfit(steamPrice, lisPrice);
            setCardCalculatedProfit(totalCard, calculatedProfit, lisPrice);
            setSteamBreakdown(targetLinkElement, breakdownRows);
            applyProfitBadgeColor(targetLinkElement, calculatedProfit, getProfitPercentFromCard(totalCard));
            removeCardBelowProfitThreshold(totalCard);

            return {
                status: 'price',
                priceText,
                ordersCount,
                steamOrderRows
            };
        };

        const showParserError = (reason, status = 'parser-error') => {
            console.error(`[Profit Calculator Parser Error] ${reason} for "${marketHashName}"`);
            targetLinkElement.innerText = "Ответ Steam не распознан";
            targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
            totalCard.setAttribute('data-calculated-profit', -999999);
            totalCard.removeAttribute('data-calculated-profit-percent');
            if (onComplete) onComplete(status);
        };

        const fetchHistogramOrFallback = (itemNameId, fallbackBuyOrders = null) => {
            histogramRequest = fetchSteamOrderHistogram(itemNameId, operation, (status, data) => {
                if (status === 429) {
                    if (onComplete) onComplete(429);
                    return;
                }

                if (status === 200 && data?.status === 'price') {
                    const result = applySteamBuyOrders(data.buyOrders);
                    if (onComplete) onComplete(result ? 200 : 'invalid-price', result || undefined);
                    return;
                }

                if (fallbackBuyOrders) {
                    const result = applySteamBuyOrders(fallbackBuyOrders);
                    if (onComplete) onComplete(result ? 200 : 'invalid-price', result || undefined);
                    return;
                }

                if (status === 200 && data?.status === 'no-orders') {
                    setCardNoBuyOrders(targetLinkElement, totalCard);
                    if (onComplete) onComplete(200, { status: 'no-orders' });
                    return;
                }

                showParserError(`Histogram fallback failed. Status: ${status}`);
            });
        };

        const fetchRenderOrFallback = (itemNameId = '', fallbackBuyOrders = null) => {
            renderRequest = fetchSteamListingRender(targetUrl, operation, (status, data) => {
                if (status === 429) {
                    if (onComplete) onComplete(429);
                    return;
                }

                if (status === 200 && data?.status === 'price') {
                    const result = applySteamBuyOrders(data.buyOrders);
                    if (onComplete) onComplete(result ? 200 : 'invalid-price', result || undefined);
                    return;
                }

                if (itemNameId) {
                    fetchHistogramOrFallback(itemNameId, fallbackBuyOrders);
                    return;
                }

                if (fallbackBuyOrders) {
                    const result = applySteamBuyOrders(fallbackBuyOrders);
                    if (onComplete) onComplete(result ? 200 : 'invalid-price', result || undefined);
                    return;
                }

                if (status === 200 && data?.status === 'no-orders') {
                    setCardNoBuyOrders(targetLinkElement, totalCard);
                    if (onComplete) onComplete(200, { status: 'no-orders' });
                    return;
                }

                showParserError(`Render fallback failed. Status: ${status}`);
            });
        };

        const fetchHtmlFallback = () => {
            pageRequest = GM_xmlhttpRequest({
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
                    targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
                    totalCard.setAttribute('data-calculated-profit', -999999);
                    totalCard.removeAttribute('data-calculated-profit-percent');
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
                        const itemNameId = findSteamItemNameId(htmlText);
                        const hasDetailedRows = buyOrders.table || (Array.isArray(buyOrders.steamOrderRows) && buyOrders.steamOrderRows.length > 0);
                        if (!hasDetailedRows) {
                            fetchRenderOrFallback(itemNameId, buyOrders);
                            return;
                        }

                        const result = applySteamBuyOrders(buyOrders);
                        if (!result) {
                            if (onComplete) onComplete('invalid-price');
                            return;
                        }

                        priceFound = true;
                        if (onComplete) onComplete(200, result);
                    }

                    if (!priceFound && hasExplicitNoBuyOrdersMessage(doc)) {
                        setCardNoBuyOrders(targetLinkElement, totalCard);
                        if (onComplete) onComplete(200, { status: 'no-orders' });
                    } else if (!priceFound) {
                        const itemNameId = findSteamItemNameId(htmlText);
                        console.error(`[Profit Calculator Debug] HTML parser did not find buy orders for "${marketHashName}". item_nameid="${itemNameId || 'not found'}"`);
                        fetchRenderOrFallback(itemNameId);
                    }
                } catch (e) {
                    console.error(`[Profit Calculator Error] Сбой обработки DOM для "${marketHashName}":`, e);
                    targetLinkElement.innerText = "Страница Steam изменилась";
                    targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
                    totalCard.setAttribute('data-calculated-profit', -999999);
                    totalCard.removeAttribute('data-calculated-profit-percent');
                    if (onComplete) onComplete('error');
                }

            },
            onerror: function(err) {
                if (!isOperationActive(operation)) {
                    if (onComplete) onComplete('cancelled');
                    return;
                }
                console.error(`[Profit Calculator Network Error] Сбой сети для "${marketHashName}":`, err);
                targetLinkElement.innerText = "Ошибка сети";
                targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
                totalCard.setAttribute('data-calculated-profit', -999999);
                totalCard.removeAttribute('data-calculated-profit-percent');
                if (onComplete) onComplete('error');
            },
            ontimeout: function() {
                if (!isOperationActive(operation)) {
                    if (onComplete) onComplete('cancelled');
                    return;
                }
                console.error(`[Profit Calculator Timeout] Steam не ответил за ${STEAM_REQUEST_TIMEOUT_MS / 1000}с для "${marketHashName}"`);
                targetLinkElement.innerText = "Steam не ответил";
                targetLinkElement.style.setProperty('background', PROFIT_COLOR_NEGATIVE, 'important');
                totalCard.setAttribute('data-calculated-profit', -999999);
                totalCard.removeAttribute('data-calculated-profit-percent');
                if (onComplete) onComplete('timeout');
            },
            onabort: function() {
                if (onComplete) onComplete('cancelled');
            }
            });
        };

        orderBookRequest = fetchSteamOrderBook(appId, marketHashName, operation, (status, data) => {
            if (status === 429) {
                if (onComplete) onComplete(429);
                return;
            }

            if (status === 200 && data?.status === 'price') {
                const result = applySteamBuyOrders(data.buyOrders);
                if (onComplete) onComplete(result ? 200 : 'invalid-price', result || undefined);
                return;
            }

            if (status === 200 && data?.status === 'no-orders') {
                setCardNoBuyOrders(targetLinkElement, totalCard);
                if (onComplete) onComplete(200, { status: 'no-orders' });
                return;
            }

            console.error(`[Profit Calculator Debug] Orderbook failed for "${marketHashName}". Status: ${status}. Falling back to HTML parser.`);
            fetchHtmlFallback();
        });

        return {
            abort: () => {
                if (pageRequest && typeof pageRequest.abort === 'function') pageRequest.abort();
                if (orderBookRequest && typeof orderBookRequest.abort === 'function') orderBookRequest.abort();
                if (histogramRequest && typeof histogramRequest.abort === 'function') histogramRequest.abort();
                if (renderRequest && typeof renderRequest.abort === 'function') renderRequest.abort();
            }
        };
    }

    function formatPriceWithProfit(steamPriceRaw, targetLinkElement, ordersCount = '') {
        const steamPrice = parsePriceValue(steamPriceRaw);
        const lisPrice = parseFloat(targetLinkElement.getAttribute('data-lis-price')) || 0;

        if (!isValidPrice(steamPrice)) return 'Ошибка цены Steam';
        if (!isValidPrice(lisPrice)) return 'Ошибка цены LIS';

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
        let value = String(text || '')
            .replace(/\s| /g, '')
            .replace(/[^0-9.,-]/g, '')
            .replace(/^[.,]+|[.,]+$/g, '');

        if (!value) return NaN;

        const lastDot = value.lastIndexOf('.');
        const lastComma = value.lastIndexOf(',');

        if (lastDot !== -1 && lastComma !== -1) {
            const decimalSeparator = lastDot > lastComma ? '.' : ',';
            const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';

            value = value
                .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
                .replace(decimalSeparator, '.');

            return parseFloat(value);
        }

        const separator = lastDot !== -1 ? '.' : lastComma !== -1 ? ',' : '';
        if (!separator) return parseFloat(value);

        const separatorParts = value.split(separator);
        const lastPart = separatorParts[separatorParts.length - 1];
        const hasSeveralSeparators = separatorParts.length > 2;
        const looksLikeThousandsOnly = lastPart.length === 3;

        if (hasSeveralSeparators || looksLikeThousandsOnly) {
            if (hasSeveralSeparators && !looksLikeThousandsOnly) {
                const decimalPart = separatorParts.pop();
                return parseFloat(`${separatorParts.join('')}.${decimalPart}`);
            }

            return parseFloat(separatorParts.join(''));
        }

        return parseFloat(value.replace(separator, '.'));
    }

    function toCents(value) {
        return Math.round(value * 100);
    }

    function fromCents(value) {
        return value / 100;
    }

    function calculateSteamFeeCents(sellerReceivesCents, feeRate) {
        return Math.max(Math.floor(sellerReceivesCents * feeRate), 1);
    }

    function calculateSteamBuyerPaysCents(sellerReceivesCents) {
        return sellerReceivesCents
            + calculateSteamFeeCents(sellerReceivesCents, STEAM_FEE_RATE)
            + calculateSteamFeeCents(sellerReceivesCents, STEAM_GAME_FEE_RATE);
    }

    function calculateSteamNetSaleCents(buyerPaysCents) {
        let left = 0;
        let right = Math.max(buyerPaysCents, 0);
        let best = 0;

        while (left <= right) {
            const middle = Math.floor((left + right) / 2);
            const calculatedBuyerPays = calculateSteamBuyerPaysCents(middle);

            if (calculatedBuyerPays <= buyerPaysCents) {
                best = middle;
                left = middle + 1;
            } else {
                right = middle - 1;
            }
        }

        return best;
    }

    function calculateSteamSale(steamPrice, lisPrice) {
        const salePriceCents = toCents(steamPrice);
        const lisPriceCents = toCents(lisPrice);
        const netSaleCents = calculateSteamNetSaleCents(salePriceCents);
        const commissionCents = salePriceCents - netSaleCents;

        return {
            buyPrice: fromCents(lisPriceCents),
            salePrice: fromCents(salePriceCents),
            grossProfit: fromCents(salePriceCents - lisPriceCents),
            commission: fromCents(commissionCents),
            netSale: fromCents(netSaleCents),
            netProfit: fromCents(netSaleCents - lisPriceCents)
        };
    }

    function calculateNetProfit(steamPrice, lisPrice) {
        return calculateSteamSale(steamPrice, lisPrice).netProfit;
    }

    function setCardCalculatedProfit(totalCard, profit, lisPrice) {
        totalCard.setAttribute('data-calculated-profit', profit);

        if (isValidPrice(lisPrice) && profit !== null && Number.isFinite(profit)) {
            totalCard.setAttribute('data-calculated-profit-percent', (profit / lisPrice) * 100);
        } else {
            totalCard.removeAttribute('data-calculated-profit-percent');
        }
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

    function formatProfitPercent(profit, basePrice) {
        if (basePrice <= 0 || profit === null) return '';

        const profitPercent = (profit / basePrice) * 100;
        const sign = profitPercent > 0 ? '+' : '';

        return `${sign}${profitPercent.toFixed(2)}%`;
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

        return Array.from(table.querySelectorAll('tbody tr')).slice(0, MAX_STEAM_TOOLTIP_ROWS).map(row => {
            const cells = row.querySelectorAll('td');
            const salePriceText = cells[0]?.textContent.trim() || '';
            const salePrice = parsePriceValue(salePriceText);
            const ordersCount = cells[1]?.textContent.trim().replace(/\s| /g, '') || '';

            if (!isValidPrice(salePrice)) return null;

            return {
                salePriceText,
                ordersCount,
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
                ordersCount: row.ordersCount,
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

    function getProfitState(profit, basePrice) {
        if (profit !== null && profit < 0) return 'bad';

        const profitPercent = basePrice > 0 && profit !== null ? (profit / basePrice) * 100 : null;
        if (profitPercent !== null && profitPercent > EXCELLENT_PROFIT_PERCENT_THRESHOLD) return 'excellent';
        if (profitPercent !== null && profitPercent >= PROFITABLE_PERCENT_THRESHOLD) return 'good';

        return 'neutral';
    }

    function getProfitColorByState(state) {
        if (state === 'excellent') return PROFIT_COLOR_EXCELLENT;
        if (state === 'good') return PROFIT_COLOR_POSITIVE;
        if (state === 'bad') return PROFIT_COLOR_NEGATIVE;
        return PROFIT_COLOR_NEUTRAL;
    }

    function getProfitCellClass(profit, basePrice) {
        return `lis-profit-cell-${getProfitState(profit, basePrice)}`;
    }

    function buildBreakdownTooltipHtml(rows) {
        const bodyRows = rows.slice(0, getTooltipRowsCount()).map(row => `
            <tr>
                <td>${formatCurrency(row.buyPrice)}</td>
                <td>${formatCurrency(row.salePrice)}</td>
                <td>${escapeHtml(row.ordersCount || '-')}</td>
                <td class="${getProfitCellClass(row.grossProfit, row.buyPrice)}">${formatMoney(row.grossProfit)}</td>
                <td>${formatCurrency(row.commission)}</td>
                <td>${formatCurrency(row.netSale)}</td>
                <td class="${getProfitCellClass(row.netProfit, row.buyPrice)}">${formatMoney(row.netProfit)}</td>
                <td class="${getProfitCellClass(row.netProfit, row.buyPrice)}">${formatProfitPercent(row.netProfit, row.buyPrice)}</td>
            </tr>
        `).join('');

        return `
            <table>
                <thead>
                    <tr>
                        <th>Покупка</th>
                        <th>Продажа</th>
                        <th>Заявки</th>
                        <th>Без комиссии</th>
                        <th>Комиссия</th>
                        <th>К получению</th>
                        <th>Профит</th>
                        <th>Выгода</th>
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
        const storedProfitPercent = parseFloat(card.getAttribute('data-calculated-profit-percent'));
        if (Number.isFinite(storedProfitPercent)) return storedProfitPercent;

        const badge = card.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
        if (!badge) return null;

        const profit = getValidProfit(card);
        return getProfitPercentFromBadge(badge, profit);
    }

    function removeCardBelowProfitThreshold(card) {
        const profitPercent = getProfitPercentFromCard(card);

        if (profitPercent !== null && profitPercent < getProfitDeleteThreshold()) {
            card.remove();
            return true;
        }

        return false;
    }

    function isVisibleCard(card) {
        return card.style.display !== 'none';
    }

    function isErrorBadgeText(text) {
        return text.startsWith('Ошибка')
            || text.startsWith('Ответ Steam')
            || text.startsWith('Страница Steam')
            || text.startsWith('Steam не ответил')
            || text.startsWith('Лимит повторов')
            || text.startsWith('Блок ');
    }

    function getResultStats() {
        const cards = Array.from(document.querySelectorAll('.skins-market-skins-list > .item')).filter(isVisibleCard);
        const stats = {
            total: cards.length,
            profitable: 0,
            errors: 0,
            noOrders: 0
        };

        cards.forEach(card => {
            const badge = card.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
            if (!badge) return;

            const badgeText = badge.innerText || '';
            if (badgeText === 'Нет заявок') {
                stats.noOrders++;
                return;
            }
            if (isErrorBadgeText(badgeText)) {
                stats.errors++;
                return;
            }

            const profitPercent = getProfitPercentFromCard(card);
            if (profitPercent !== null && profitPercent >= PROFITABLE_PERCENT_THRESHOLD) {
                stats.profitable++;
            }
        });

        return stats;
    }

    function formatResultStats(stats = getResultStats()) {
        return `Готово: карточек ${stats.total}, выгодных ${stats.profitable}, ошибок ${stats.errors}, без заявок ${stats.noOrders}`;
    }

    function getProfitStateByPercent(profitPercent) {
        if (profitPercent === null || !Number.isFinite(profitPercent)) return 'neutral';
        if (profitPercent < 0) return 'bad';
        if (profitPercent > EXCELLENT_PROFIT_PERCENT_THRESHOLD) return 'excellent';
        if (profitPercent >= PROFITABLE_PERCENT_THRESHOLD) return 'good';

        return 'neutral';
    }

    function setBadgeBackground(badge, color) {
        badge.style.setProperty('background', color, 'important');
    }

    function applyProfitBadgeColor(badge, profit, knownProfitPercent = null) {
        const profitPercent = knownProfitPercent ?? getProfitPercentFromBadge(badge, profit);

        if (badge.innerText === 'Загружаю') {
            setBadgeBackground(badge, COLOR_LOADING);
        } else if (badge.innerText.startsWith('Пауза Steam')) {
            setBadgeBackground(badge, COLOR_PAUSED);
        } else if (badge.innerText === 'Нет заявок') {
            setBadgeBackground(badge, COLOR_NO_ORDERS);
        } else if (isErrorBadgeText(badge.innerText || '')) {
            setBadgeBackground(badge, PROFIT_COLOR_NEGATIVE);
        } else if (profitPercent !== null) {
            setBadgeBackground(badge, getProfitColorByState(getProfitStateByPercent(profitPercent)));
        } else {
            setBadgeBackground(badge, PROFIT_COLOR_NEUTRAL);
        }
    }

    function updateProfitBadgeColors(cardsArray) {
        cardsArray.forEach(card => {
            const badge = card.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
            if (!badge) return;

            const profit = getValidProfit(card);
            applyProfitBadgeColor(badge, profit, getProfitPercentFromCard(card));
        });
    }

    function sortCardsByProfit(updateStatus = true) {
        const gridContainer = document.querySelector('.skins-market-skins-list');
        const statusDiv = document.getElementById('combine-status');
        if (!gridContainer) return;

        if (updateStatus && statusDiv) statusDiv.innerText = "Сортирую по выгоде";

        let cardsArray = Array.from(gridContainer.querySelectorAll('.skins-market-skins-list > .item'));

        cardsArray = cardsArray.filter(card => {
            return !removeCardBelowProfitThreshold(card);
        });

        cardsArray.sort((a, b) => {
            const profitPercentA = getProfitPercentFromCard(a);
            const profitPercentB = getProfitPercentFromCard(b);

            return (profitPercentB ?? -999998) - (profitPercentA ?? -999998);
        });

        cardsArray.forEach(card => gridContainer.appendChild(card));
        updateProfitBadgeColors(cardsArray);

        if (updateStatus && statusDiv) statusDiv.innerText = "Готово";
    }

    function applyDiffFilter(operation, options = {}) {
        if (!isOperationActive(operation)) return;

        const startSteamQueue = options.startSteamQueue !== false;
        const minVal = parseFloat(document.getElementById('diff-num-input').value) || 0;
        const allCards = document.querySelectorAll('.skins-market-skins-list .item');

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
                    let itemName = getMarketHashNameFromCard(totalCard, currentAppId);

                    if (itemName) {
                        const steamLink = document.createElement('a');
                        steamLink.className = 'steam-highest-buy-order-link';
                        steamLink.setAttribute('data-lis-helper-badge', 'true');
                        steamLink.target = '_blank';
                        steamLink.style = `
                        position: absolute; top: 32px; left: 10px; right: 10px; z-index: 30;
                        background: ${COLOR_LOADING}; color: ${COLOR_TEXT} !important; padding: 3px 8px;
                        font-family: Arial, "Helvetica Neue", sans-serif;
                        font-size: 11px; font-weight: bold; border-radius: 4px;
                        text-decoration: none !important; box-shadow: 0 2px 5px ${COLOR_BADGE_SHADOW};
                        display: block; box-sizing: border-box; line-height: 1.25;
                        white-space: normal; overflow-wrap: anywhere; text-align: left;
                        `;
                        steamLink.innerText = 'Загружаю';
                        attachProfitTooltip(steamLink);

                        const lisPriceElem = totalCard.querySelector('.price');
                        const lisPrice = lisPriceElem ? parseFloat(lisPriceElem.innerText.replace(/[^0-9.,]/g, '').replace(',', '.')) : 0;
                        steamLink.setAttribute('data-lis-price', lisPrice);

                        if (!isValidPrice(lisPrice)) {
                            setCardPriceError(steamLink, totalCard, 'Ошибка цены LIS');
                            totalCard.appendChild(steamLink);
                            return;
                        }

                        const steamMarketHashName = normalizeSteamMarketHashName(itemName, currentAppId);
                        const targetSteamUrl = buildSteamListingUrl(currentAppId, steamMarketHashName, totalCard);
                        steamLink.setAttribute('href', targetSteamUrl);
                        totalCard.appendChild(steamLink);

                        steamRequestsQueue.push({
                            targetUrl: targetSteamUrl,
                            appId: currentAppId,
                            marketHashName: steamMarketHashName,
                            targetLinkElement: steamLink,
                            totalCard: totalCard
                        });
                    }
                }
            } else {
                totalCard.style.display = 'none';
            }
        });

        const queuedCount = steamRequestsQueue.length;

        if (startSteamQueue && queuedCount > 0 && !isQueueRunning && isOperationActive(operation)) {
            processNextSteamRequest(operation);
        }

        return queuedCount;
    }

    async function processLoadedCardsChunk(operation, statusText = 'Проверяю загруженные карточки') {
        if (!isOperationActive(operation)) return 0;

        const statusDiv = document.getElementById('combine-status');
        if (statusDiv) statusDiv.innerText = statusText;

        const queuedCount = applyDiffFilter(operation, { startSteamQueue: false });
        if (queuedCount > 0 && isOperationActive(operation)) {
            await processNextSteamRequest(operation, false);
        } else {
            sortCardsByProfit(false);
        }

        return queuedCount || 0;
    }

    function finishAfterDiffFilter(operation, queuedCount) {
        if (!isOperationActive(operation)) return;

        if (queuedCount === 0) {
            const hasBadges = document.querySelector('.steam-highest-buy-order-link[data-lis-helper-badge="true"]');
            if (hasBadges) {
                sortCardsByProfit();
                finishOperation(operation);
                return;
            }

            finishOperation(operation, 'Готово!');
            showSuccessToast('Готово. Подходящих карточек нет.');
            return;
        }

        const statusDiv = document.getElementById('combine-status');
        if (statusDiv) statusDiv.innerText = `Steam: старт`;
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

        pagesCount = Math.min(pagesCount, 999);

        const gridContainer = document.querySelector('.skins-market-skins-list');
        if (!gridContainer) {
            finishOperation(operation, "Не найдена сетка карточек");
            return;
        }

        if (pagesCount <= 1) {
            const queuedCount = applyDiffFilter(operation);
            if (isOperationActive(operation)) statusDiv.innerText = "Проверяю карточки";
            finishAfterDiffFilter(operation, queuedCount);
            return;
        }

        const baseUrl = window.location.origin + window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);
        const lisPagesConcurrency = getLisPagesConcurrency();
        let cardsPendingSteamProcess = gridContainer.querySelectorAll('.skins-market-skins-list > .item').length;
        operation.lisProgress = {
            total: pagesCount - 1,
            completed: 0,
            pagesCount,
            startedAt: Date.now()
        };

        const loadLisPage = async (pageNumber) => {
            const pageSearchParams = new URLSearchParams(searchParams);
            pageSearchParams.set('page', pageNumber);
            const targetUrl = `${baseUrl}?${pageSearchParams.toString()}`;
            if (!isOperationActive(operation)) return;

            for (let attempt = 1; attempt <= LIS_PAGE_MAX_RETRIES + 1; attempt++) {
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
                    if (!isOperationActive(operation)) return { page: pageNumber, cancelled: true };

                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const htmlText = await response.text();
                    clearTimeout(timeoutId);
                    operation.cleanups.delete(cleanup);
                    if (!isOperationActive(operation)) return { page: pageNumber, cancelled: true };

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');
                    const remoteCards = doc.querySelectorAll('.skins-market-skins-list > .item');

                    const cards = Array.from(remoteCards).map(card => {
                        const clonedCard = card.cloneNode(true);
                        clonedCard.classList.add('loaded-by-script');
                        return clonedCard;
                    });

                    return { page: pageNumber, cards };
                } catch (err) {
                    if (cleanup) {
                        cleanup();
                        operation.cleanups.delete(cleanup);
                    }
                    if (!isOperationActive(operation)) return { page: pageNumber, cancelled: true };

                    if (attempt <= LIS_PAGE_MAX_RETRIES) {
                        await waitForOperation(operation, LIS_PAGE_RETRY_DELAY_MS);
                        continue;
                    }

                    return {
                        page: pageNumber,
                        error: true,
                        timedOut: requestTimedOut
                    };
                }
            }
        };

        const pagesToLoad = Array.from({ length: pagesCount - 1 }, (_, index) => index + 2);

        for (let start = 0; start < pagesToLoad.length; start += lisPagesConcurrency) {
            if (!isOperationActive(operation)) return;
            updateLisProgress(operation);

            const batch = pagesToLoad.slice(start, start + lisPagesConcurrency);
            const results = await Promise.all(batch.map(loadLisPage));
            if (!isOperationActive(operation)) return;

            let shouldStopLoading = false;
            results
                .sort((a, b) => a.page - b.page)
                .forEach(result => {
                    if (shouldStopLoading || result.cancelled) return;

                    if (result.error) {
                        if (result.timedOut) {
                            showErrorToast(`Страница ${result.page} LIS не ответила после ${LIS_PAGE_MAX_RETRIES + 1} попыток.`);
                            statusDiv.innerText = `Таймаут LIS на странице ${result.page}. Пропускаем страницу.`;
                        } else {
                            showErrorToast(`Не удалось загрузить страницу ${result.page} LIS после ${LIS_PAGE_MAX_RETRIES + 1} попыток.`);
                            statusDiv.innerText = `Ошибка LIS на странице ${result.page}. Пропускаем страницу.`;
                        }
                        return;
                    }

                    result.cards.forEach(card => gridContainer.appendChild(card));
                    cardsPendingSteamProcess += result.cards.length;
                    operation.lisProgress.completed++;

                    if (result.cards.length === 0) {
                        shouldStopLoading = true;
                    }
                });

            if (cardsPendingSteamProcess > LIS_EARLY_STEAM_PROCESS_CARD_THRESHOLD) {
                await processLoadedCardsChunk(operation, `Загружено больше ${LIS_EARLY_STEAM_PROCESS_CARD_THRESHOLD} карточек. Проверяю цены.`);
                cardsPendingSteamProcess = 0;
                if (!isOperationActive(operation)) return;
            }

            if (shouldStopLoading) break;
        }

        if (!isOperationActive(operation)) return;
        statusDiv.innerText = "Проверяю карточки";

        const queuedCount = applyDiffFilter(operation);
        finishAfterDiffFilter(operation, queuedCount);
    }

    const observer = new MutationObserver(() => {
        if (!document.getElementById('lis-helper-panel')) {
            panelInjected = false;
            injectPanel();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
