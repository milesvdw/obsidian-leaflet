import {
    Notice,
    MarkdownView,
    MarkdownPostProcessorContext,
    setIcon,
    Plugin,
    TFile
} from "obsidian";
import { latLng, Circle, LatLngTuple } from "leaflet";

//Local Imports
import "./main.css";

import { ObsidianLeafletSettingTab } from "./settings";
import {
    getIcon,
    DEFAULT_SETTINGS,
    toDataURL,
    getHeight,
    getParamsFromSource,
    getImmutableItems,
    getMarkerIcon,
    renderError,
    OVERLAY_TAG_REGEX,
    getId
} from "./utils";
import {
    IMapInterface,
    ILeafletMarker,
    IMarkerData,
    IMarkerIcon,
    IObsidianAppData,
    IMarker,
    Marker,
    LeafletMap,
    Length
} from "./@types";
import { MarkerContextModal } from "./modals";

import { LeafletRenderer } from "./leaflet";
import { markerDivIcon } from "./map";
import convert from "convert";

//add commands to app interface
declare module "obsidian" {
    interface App {
        commands: {
            listCommands(): Command[];
            executeCommandById(id: string): void;
            findCommand(id: string): Command;
            commands: { [id: string]: Command };
        };
        keymap: {
            pushScope(scope: Scope): void;
            popScope(scope: Scope): void;
        };
    }
}

export default class ObsidianLeaflet extends Plugin {
    AppData: IObsidianAppData;
    markerIcons: IMarkerIcon[];
    maps: IMapInterface[] = [];
    mapFiles: { file: string; maps: string[] }[] = [];
    watchers: Set<TFile> = new Set();
    /* escapeScope: Scope; */
    async onload(): Promise<void> {
        console.log("Loading Obsidian Leaflet v" + this.manifest.version);

        await this.loadSettings();
        this.markerIcons = this.generateMarkerMarkup(this.AppData.markerIcons);

        this.registerMarkdownCodeBlockProcessor(
            "leaflet",
            this.postprocessor.bind(this)
        );

        this.registerEvent(
            this.app.vault.on("rename", async (file, oldPath) => {
                if (!file) return;
                if (!this.mapFiles.find(({ file: f }) => f === oldPath)) return;

                this.mapFiles.find(({ file: f }) => f === oldPath).file =
                    file.path;

                await this.saveSettings();
            })
        );
        this.registerEvent(
            this.app.vault.on("delete", async (file) => {
                if (!file) return;
                if (!this.mapFiles.find(({ file: f }) => f === file.path))
                    return;

                this.mapFiles = this.mapFiles.filter(
                    ({ file: f }) => f != file.path
                );

                await this.saveSettings();
            })
        );

        this.addSettingTab(new ObsidianLeafletSettingTab(this.app, this));
    }

    async onunload(): Promise<void> {
        console.log("Unloading Obsidian Leaflet");
        this.maps.forEach((map) => {
            map?.map?.remove();
            let newPre = createEl("pre");
            newPre.createEl("code", {}, (code) => {
                code.innerText = `\`\`\`leaflet\n${map.source}\`\`\``;
                map.el.parentElement.replaceChild(newPre, map.el);
            });
        });
        this.maps = [];
    }

    async postprocessor(
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ): Promise<void> {
        try {
            /** Get Parameters from Source */
            let params = getParamsFromSource(source);
            let {
                height = "500px",
                minZoom = 1,
                maxZoom = 10,
                defaultZoom = 5,
                zoomDelta = 1,
                lat = `${this.AppData.lat}`,
                long = `${this.AppData.long}`,
                coordinates,
                id = undefined,
                scale = 1,
                unit = "m",
                distanceMultiplier = 1,
                darkMode = "false",
                image = "real",
                layers = [],
                overlay = [],
                overlayColor = "blue",
                bounds,
                linksFrom = [],
                linksTo = []
            } = params;
            if (!id) {
                new Notice(
                    "As of version 3.0.0, Obsidian Leaflet maps must have an ID."
                );
                new Notice(
                    "All marker data associated with this map will sync to the new ID."
                );
                throw new Error("ID required");
            }
            let view = this.app.workspace.getActiveViewOfType(MarkdownView);

            /** Get Markers from Parameters */

            /** Update Old Map Data Format */
            if (
                this.AppData.mapMarkers.find(
                    ({ path, id: mapId }) =>
                        (path == `${ctx.sourcePath}/${image}` && !mapId) ||
                        path == `${ctx.sourcePath}/${id}`
                )
            ) {
                let data = this.AppData.mapMarkers.find(
                    ({ path }) =>
                        path == `${ctx.sourcePath}/${image}` ||
                        path == `${ctx.sourcePath}/${id}`
                );
                this.AppData.mapMarkers = this.AppData.mapMarkers.filter(
                    (d) => d != data
                );

                data.id = id;
                this.AppData.mapMarkers.push({
                    id: data.id,
                    markers: data.markers,
                    files: [ctx.sourcePath],
                    lastAccessed: Date.now(),
                    overlays: data.overlays || []
                });
            }
            const renderer = new LeafletRenderer(this, ctx.sourcePath, el, {
                height: getHeight(view, height) ?? "500px",
                type: image != "real" ? "image" : "real",
                minZoom: +minZoom,
                maxZoom: +maxZoom,
                defaultZoom: +defaultZoom,
                zoomDelta: +zoomDelta,
                unit: unit,
                scale: scale,
                distanceMultiplier: distanceMultiplier,
                id: id,
                darkMode: `${darkMode}` === "true",
                overlayColor: overlayColor,
                bounds: bounds
            });
            const map = renderer.map;

            let {
                markers: immutableMarkers,
                overlays: immutableOverlays,
                files: watchers
            } = await getImmutableItems(
                /* source */
                this.app,
                params.marker as string[],
                params.commandMarker as string[],
                params.markerTag as string[][],
                params.markerFile as string[],
                params.markerFolder as string[],
                linksTo.flat(Infinity),
                linksFrom.flat(Infinity),
                params.overlayTag,
                params.overlayColor
            );
            for (let [
                type,
                lat,
                long,
                link,
                layer = layers[0],
                command = false,
                id = getId()
            ] of immutableMarkers) {
                map.createMarker(
                    this.markerIcons.find(({ type: t }) => t == type),
                    latLng([Number(lat), Number(long)]),
                    link?.trim(),
                    id,
                    layer,
                    false,
                    command
                );
            }
            const overlayArray: [
                string,
                [number, number],
                number,
                string,
                string,
                string
            ][] = [...overlay, ...immutableOverlays].map(
                ([color, loc, length, desc, id = getId()]) => {
                    const match = length.match(OVERLAY_TAG_REGEX);
                    if (!match || isNaN(Number(match[1]))) {
                        throw new Error(
                            "Could not parse overlay radius. Please make sure it is in the format `<length> <unit>`."
                        );
                    }
                    const [, radius, unit = "m"] = match;
                    return [color, loc, Number(radius), unit, desc, id];
                }
            );
            overlayArray.sort((a, b) => {
                const radiusA = convert(a[2])
                    .from(a[3] as Length)
                    .to("m");
                const radiusB = convert(b[2])
                    .from(b[3] as Length)
                    .to("m");
                return radiusB - radiusA;
            });
            for (let [color, loc, radius, unit, desc, id] of overlayArray) {
                map.addOverlay(
                    {
                        radius: Number(radius),
                        loc: loc,
                        color: color,
                        unit: unit as Length,
                        layer: layers[0],
                        desc: desc,
                        id: id
                    },
                    false
                );
            }

            /** Register File Watcher to Update Markers/Overlays */
            if (watchers.size) {
                this.registerEvent(
                    this.app.metadataCache.on("changed", (file) => {
                        if (!(file instanceof TFile)) return;
                        if (!watchers.has(file)) return;
                        const cache = this.app.metadataCache.getFileCache(file);
                        if (!cache || !cache.frontmatter) return;

                        const fileId = watchers.get(file);
                        const marker = map.getMarkerById(fileId);

                        if (
                            marker &&
                            cache.frontmatter.location &&
                            cache.frontmatter.location instanceof Array
                        ) {
                            try {
                                const { location } = cache.frontmatter;
                                if (
                                    location.length == 2 &&
                                    location.every((v) => typeof v == "number")
                                ) {
                                    if (
                                        !marker.loc.equals(
                                            latLng(<LatLngTuple>location)
                                        )
                                    ) {
                                        marker.setLatLng(
                                            latLng(<LatLngTuple>location)
                                        );
                                    }
                                }
                            } catch (e) {
                                new Notice(
                                    `There was an error updating the marker for ${file.name}.`
                                );
                            }
                        }

                        if (marker && cache.frontmatter.mapmarker) {
                            try {
                                const { mapmarker } = cache.frontmatter;

                                if (
                                    this.markerIcons.find(
                                        ({ type }) => type == mapmarker
                                    )
                                ) {
                                    marker.icon = this.markerIcons.find(
                                        ({ type }) => type == mapmarker
                                    );
                                }
                            } catch (e) {
                                new Notice(
                                    `There was an error updating the marker type for ${file.name}.`
                                );
                            }
                        }

                        try {
                            map.overlays
                                .filter(({ id }) => id === fileId)
                                ?.forEach((overlay) => {
                                    overlay.leafletInstance.remove();
                                });
                            map.overlays = map.overlays.filter(
                                ({ id }) => id != fileId
                            );

                            cache.frontmatter.mapoverlay?.forEach(
                                ([
                                    color = overlayColor ?? "blue",
                                    loc = [0, 0],
                                    length = "1 m",
                                    desc
                                ]: [
                                    color: string,
                                    loc: [number, number],
                                    length: string,
                                    desc: string
                                ]) => {
                                    const [, radius, unit = "m"] =
                                        length.match(OVERLAY_TAG_REGEX) ?? [];
                                    if (!radius || isNaN(Number(radius))) {
                                        new Notice(
                                            `Could not parse map overlay length in ${file.name}. Please ensure it is in the format: <distance> <unit>`
                                        );
                                        return;
                                    }
                                    map.addOverlay(
                                        {
                                            color: color,
                                            loc: loc,
                                            radius: Number(radius),
                                            unit: unit as Length,
                                            desc: desc,
                                            layer: map.mapLayers[0].id,
                                            id: fileId
                                        },
                                        false
                                    );
                                }
                            );
                        } catch (e) {
                            new Notice(
                                `There was an error updating the overlays for ${file.name}.`
                            );
                        }
                    })
                );

                this.registerEvent(
                    this.app.vault.on("delete", (file) => {
                        if (!(file instanceof TFile)) return;
                        if (!watchers.has(file)) return;
                        const fileId = watchers.get(file);
                        const marker = map.getMarkerById(fileId);

                        map.removeMarker(marker);

                        map.overlays
                            .filter(({ id }) => id === fileId)
                            ?.forEach((overlay) => {
                                overlay.leafletInstance.remove();
                            });
                        map.overlays = map.overlays.filter(
                            ({ id }) => id != fileId
                        );

                        watchers.delete(file);
                    })
                );

                this.registerEvent(
                    this.app.vault.on("rename", (file) => {
                        if (!(file instanceof TFile)) return;
                        if (!watchers.has(file)) return;
                        const cache = this.app.metadataCache.getFileCache(file);
                        if (!cache || !cache.frontmatter) return;

                        const fileId = watchers.get(file);
                        const marker = map.getMarkerById(fileId);

                        if (marker)
                            marker.link = this.app.metadataCache.fileToLinktext(
                                file,
                                "",
                                true
                            );
                    })
                );
            }

            const { coords, distanceToZoom } = await this._getCoordinates(
                lat,
                long,
                coordinates,
                params.zoomTag,
                map
            );

            /*             let coords: [number, number] = [undefined, undefined];
            let err: boolean = false;
            try {
                coords = [
                    Number(`${lat}`?.split("%").shift()),
                    Number(`${long}`?.split("%").shift())
                ];
            } catch (e) {
                err = true;
            }

            if (err || isNaN(coords[0]) || isNaN(coords[1])) {
                new Notice(
                    "There was an error with the provided latitude and longitude. Using defaults."
                );
            } */

            let mapData = this.AppData.mapMarkers.find(
                ({ id: mapId }) => mapId == id
            );

            await map.loadData(mapData);

            let layerData: {
                data: string;
                id: string;
            }[] = [];

            if (image != "real") {
                layerData = await Promise.all(
                    layers.map(async (image) => {
                        return {
                            id: image,
                            data: await toDataURL(
                                encodeURIComponent(image),
                                this.app
                            )
                        };
                    })
                );
                if (layerData.filter((d) => !d.data).length) {
                    throw new Error(
                        "No valid layers were provided to the image map."
                    );
                }
            }

            this.registerMapEvents(map);

            map.render({
                coords: coords,
                zoomDistance: distanceToZoom,
                layer: layerData[0],
                hasAdditional: layerData.length > 1
            });

            ctx.addChild(renderer);

            this.maps = this.maps.filter((m) => m.el != el);
            this.maps.push({
                map: map,
                source: source,
                el: el,
                id: id
            });

            if (this.mapFiles.find(({ file }) => file == ctx.sourcePath)) {
                this.mapFiles
                    .find(({ file }) => file == ctx.sourcePath)
                    .maps.push(id);
            } else {
                this.mapFiles.push({
                    file: ctx.sourcePath,
                    maps: [id]
                });
            }

            map.on("rendered", () => {
                if (layerData.length > 1)
                    map.loadAdditionalMapLayers(layerData.slice(1));
            });

            await this.saveSettings();
        } catch (e) {
            console.error(e);
            new Notice("There was an error loading the map.");
            renderError(el, e.message);
        }
    }
    private async _getCoordinates(
        lat: string,
        long: string,
        coordinates: [string, string] | [[string]],
        zoomTag: string,
        map: LeafletMap
    ): Promise<{ coords: [number, number]; distanceToZoom: number }> {
        let latitude = lat;
        let longitude = long;
        let coords: [number, number] = [undefined, undefined];
        let distanceToZoom;
        if (coordinates instanceof Array && coordinates.length) {
            const file = await this.app.metadataCache.getFirstLinkpathDest(
                coordinates.flat()[0].replace(/(\[|\])/, ""),
                ""
            );
            file: if (file && file instanceof TFile) {
                //internal, try to read note yaml for coords
                const cache = await this.app.metadataCache.getFileCache(file);
                if (
                    !cache ||
                    !cache.frontmatter ||
                    !cache.frontmatter.location ||
                    !(cache.frontmatter.location instanceof Array)
                )
                    break file;
                const location = cache.frontmatter.location;
                latitude = location[0];
                longitude = location[1];

                if (
                    !zoomTag ||
                    !Object.prototype.hasOwnProperty.call(
                        cache.frontmatter,
                        zoomTag
                    )
                )
                    break file;

                const overlay = cache.frontmatter[zoomTag];
                const [, distance, unit] =
                    overlay?.match(OVERLAY_TAG_REGEX) ?? [];
                if (!distance) break file;
                //try to scale default zoom

                distanceToZoom = convert(distance)
                    .from((unit as Length) ?? "m")
                    .to(map.type == "image" ? map.unit : "m");
                if (map.type == "image") {
                    distanceToZoom = distanceToZoom / map.scale;
                }
            } else if (coordinates.length == 2) {
                latitude = coordinates[0];
                longitude = coordinates[1];
            }
        }

        let err: boolean = false;
        try {
            coords = [
                Number(`${latitude}`?.split("%").shift()),
                Number(`${longitude}`?.split("%").shift())
            ];
        } catch (e) {
            err = true;
        }

        if (err || isNaN(coords[0]) || isNaN(coords[1])) {
            new Notice(
                "There was an error with the provided latitude and longitude. Using defaults."
            );
        }

        if (map.type != "real") {
            if (!latitude || isNaN(coords[0])) {
                coords[0] = 50;
            }
            if (!longitude || isNaN(coords[1])) {
                coords[1] = 50;
            }
        } else {
            if (!latitude || isNaN(coords[0])) {
                coords[0] = this.AppData.lat;
            }
            if (!longitude || isNaN(coords[1])) {
                coords[1] = this.AppData.long;
            }
        }
        return { coords, distanceToZoom };
    }

    async loadSettings() {
        this.AppData = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
        this.AppData.previousVersion = this.manifest.version;
        if (
            !this.AppData.defaultMarker ||
            !this.AppData.defaultMarker.iconName
        ) {
            this.AppData.defaultMarker = DEFAULT_SETTINGS.defaultMarker;
            this.AppData.layerMarkers = false;
        }
        await this.saveSettings();
    }
    async saveSettings() {
        this.maps.forEach((map) => {
            this.AppData.mapMarkers = this.AppData.mapMarkers.filter(
                ({ id }) => id != map.id
            );

            this.AppData.mapMarkers.push({
                id: map.id,
                files: this.mapFiles
                    .filter(({ maps }) => maps.indexOf(map.id) > -1)
                    .map(({ file }) => file),
                lastAccessed: Date.now(),
                markers: map.map.markers
                    .filter(({ mutable }) => mutable)
                    .map((marker): IMarkerData => {
                        return {
                            type: marker.type,
                            id: marker.id,
                            loc: [marker.loc.lat, marker.loc.lng],
                            link: marker.link,
                            layer: marker.layer,
                            command: marker.command || false,
                            zoom: marker.zoom ?? 0
                        };
                    }),
                overlays: map.map.overlays
                    .filter(({ mutable }) => mutable)
                    .map((overlay) => {
                        if (overlay.leafletInstance instanceof Circle) {
                            return {
                                radius: overlay.data.radius,
                                loc: [
                                    overlay.leafletInstance.getLatLng().lat,
                                    overlay.leafletInstance.getLatLng().lng
                                ],
                                color: overlay.leafletInstance.options.color,
                                layer: overlay.layer,
                                unit: overlay.data.unit,
                                desc: overlay.data.desc
                            };
                        }
                    })
            });
        });

        /** Only need to save maps with defined marker data */
        this.AppData.mapMarkers = this.AppData.mapMarkers.filter(
            ({ markers, overlays }) => markers.length > 0 || overlays.length > 0
        );

        /** Remove maps that haven't been accessed in more than 1 week that are not associated with a file */
        this.AppData.mapMarkers = this.AppData.mapMarkers.filter(
            ({ id, files, lastAccessed = Date.now() }) =>
                !id || files.length || Date.now() - lastAccessed <= 6.048e8
        );

        await this.saveData(this.AppData);

        this.markerIcons = this.generateMarkerMarkup(this.AppData.markerIcons);

        this.maps.forEach((map) => {
            map.map.updateMarkerIcons(this.markerIcons);
        });
    }

    generateMarkerMarkup(
        markers: IMarker[] = this.AppData.markerIcons
    ): IMarkerIcon[] {
        let ret: IMarkerIcon[] = markers.map((marker): IMarkerIcon => {
            if (!marker.transform) {
                marker.transform = this.AppData.defaultMarker.transform;
            }
            if (!marker.iconName) {
                marker.iconName = this.AppData.defaultMarker.iconName;
            }
            const params =
                marker.layer && !this.AppData.defaultMarker.isImage
                    ? {
                          transform: marker.transform,
                          mask: getIcon(this.AppData.defaultMarker.iconName),
                          classes: ["full-width-height"]
                      }
                    : {};
            let node = getMarkerIcon(marker, params).node as HTMLElement;
            node.style.color = marker.color
                ? marker.color
                : this.AppData.defaultMarker.color;

            return {
                type: marker.type,
                html: node.outerHTML,
                icon: markerDivIcon({
                    html: node.outerHTML,
                    className: `leaflet-div-icon`
                })
            };
        });
        const defaultHtml = getMarkerIcon(this.AppData.defaultMarker, {
            classes: ["full-width-height"],
            styles: {
                color: this.AppData.defaultMarker.color
            }
        }).html;
        ret.unshift({
            type: "default",
            html: defaultHtml,
            icon: markerDivIcon({
                html: defaultHtml,
                className: `leaflet-div-icon`
            })
        });

        return ret;
    }

    registerMapEvents(map: LeafletMap) {
        this.registerDomEvent(map.contentEl, "dragover", (evt) => {
            evt.preventDefault();
        });
        this.registerDomEvent(map.contentEl, "drop", (evt) => {
            evt.stopPropagation();

            let file = decodeURIComponent(
                evt.dataTransfer.getData("text/plain")
            )
                .split("file=")
                .pop();

            let marker = map.createMarker(
                map.markerIcons[0],
                map.map.mouseEventToLatLng(evt),
                file
            );
            marker.leafletInstance.closeTooltip();
        });

        this.registerEvent(
            map.on("marker-added", async (marker: ILeafletMarker) => {
                marker.leafletInstance.closeTooltip();
                marker.leafletInstance.unbindTooltip();
                this.maps
                    .filter(
                        ({ id, map: m }) =>
                            id == map.id && m.contentEl != map.contentEl
                    )
                    .forEach((map) => {
                        map.map.addMarker(marker);
                    });
                await this.saveSettings();
            })
        );

        this.registerEvent(
            map.on("marker-dragging", (marker: ILeafletMarker) => {
                this.maps
                    .filter(
                        ({ id, map: m }) =>
                            id == map.id && m.contentEl != map.contentEl
                    )
                    .forEach((otherMap) => {
                        let existingMarker = otherMap.map.markers.find(
                            (m) => m.id == marker.id
                        );
                        if (!existingMarker) return;

                        existingMarker.leafletInstance.setLatLng(
                            marker.leafletInstance.getLatLng()
                        );
                        existingMarker.loc = marker.loc;
                    });
            })
        );

        this.registerEvent(
            map.on(
                "marker-data-updated",
                async (marker: ILeafletMarker, old: any) => {
                    await this.saveSettings();
                    this.maps
                        .filter(
                            ({ id, map: m }) =>
                                id == map.id && m.contentEl != map.contentEl
                        )
                        .forEach((map) => {
                            let existingMarker = map.map.markers.find(
                                (m) => m.id == marker.id
                            );
                            if (!existingMarker) return;

                            existingMarker.leafletInstance.setLatLng(
                                marker.leafletInstance.getLatLng()
                            );
                            existingMarker.loc = marker.loc;
                        });
                }
            )
        );

        this.registerEvent(
            map.on(
                "marker-click",
                async (link: string, newWindow: boolean, command: boolean) => {
                    if (command) {
                        const commands = this.app.commands.listCommands();

                        if (
                            commands.find(
                                ({ id }) =>
                                    id.toLowerCase() ===
                                    link.toLowerCase().trim()
                            )
                        ) {
                            this.app.commands.executeCommandById(link);
                        } else {
                            new Notice(`Command ${link} could not be found.`);
                        }
                        return;
                    }
                    let internal =
                        await this.app.metadataCache.getFirstLinkpathDest(
                            link.split(/(\^|\||#)/).shift(),
                            ""
                        );

                    if (
                        /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/.test(
                            link
                        ) &&
                        !internal
                    ) {
                        //external url
                        let [, l] = link.match(
                            /((?:https?:\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b(?:[-a-zA-Z0-9@:%_\+.~#?&//=]*))/
                        );

                        let [, text = l] = link.match(/\[([\s\S]+)\]/) || l;

                        const a = createEl("a", { href: l, text: text });

                        a.click();
                        a.detach();
                    } else {
                        await this.app.workspace.openLinkText(
                            link.replace("^", "#^").split(/\|/).shift(),
                            this.app.workspace.getActiveFile()?.path,
                            newWindow
                        );
                    }
                }
            )
        );

        this.registerEvent(
            map.on("marker-context", (marker) =>
                this.handleMarkerContext(map, marker)
            )
        );

        this.registerEvent(
            map.on(
                "marker-mouseover",
                async (evt: L.LeafletMouseEvent, marker: ILeafletMarker) => {
                    if (marker.command) {
                        const commands = this.app.commands.listCommands();

                        if (
                            commands.find(
                                ({ id }) =>
                                    id.toLowerCase() ===
                                    marker.link.toLowerCase().trim()
                            )
                        ) {
                            const command = commands.find(
                                ({ id }) =>
                                    id.toLowerCase() ===
                                    marker.link.toLowerCase().trim()
                            );
                            const div = createDiv({
                                attr: {
                                    style: "display: flex; align-items: center;"
                                }
                            });
                            setIcon(
                                div.createSpan({
                                    attr: {
                                        style: "margin-right: 0.5em; display: flex; align-items: center;"
                                    }
                                }),
                                "run-command"
                            );
                            div.createSpan({ text: command.name });

                            map.openPopup(marker, div);
                        } else {
                            const div = createDiv({
                                attr: {
                                    style: "display: flex; align-items: center;"
                                }
                            });
                            setIcon(
                                div.createSpan({
                                    attr: {
                                        style: "margin-right: 0.5em; display: flex; align-items: center;"
                                    }
                                }),
                                "cross"
                            );
                            div.createSpan({ text: "No command found!" });

                            map.openPopup(marker, div);
                        }
                        return;
                    }

                    let internal =
                        await this.app.metadataCache.getFirstLinkpathDest(
                            marker.link.split(/(\^|\||#)/).shift(),
                            ""
                        );

                    if (
                        /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/.test(
                            marker.link
                        ) &&
                        !internal
                    ) {
                        //external url
                        let [, link] = marker.link.match(
                            /((?:https?:\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b(?:[-a-zA-Z0-9@:%_\+.~#?&//=]*))/
                        );

                        let [, text] = marker.link.match(/\[([\s\S]+)\]/) || [
                            ,
                            link
                        ];

                        let el = evt.originalEvent.target as SVGElement;
                        const a = createEl("a", {
                            text: text,
                            href: link,
                            cls: "external-link"
                        });

                        map.openPopup(marker, a);
                    } else {
                        if (this.AppData.notePreview && !map.isFullscreen) {
                            marker.leafletInstance.unbindTooltip();

                            this.app.workspace.trigger(
                                "link-hover",
                                this, //not sure
                                marker.leafletInstance.getElement(), //targetEl
                                marker.link
                                    .replace("^", "#^")
                                    .split("|")
                                    .shift(), //linkText
                                this.app.workspace.getActiveFile()?.path //source
                            );
                        } else {
                            map.openPopup(
                                marker,
                                marker.link
                                    .replace(/(\^)/, " > ^")
                                    .replace(/#/, " > ")
                                    .split("|")
                                    .pop()
                            );
                        }
                    }
                }
            )
        );
    }
    handleMarkerContext(map: LeafletMap, marker: Marker) {
        let markerSettingsModal = new MarkerContextModal(this, marker, map);
        const otherMaps = this.maps.filter(
            ({ id, map: m }) => id == map.id && m.contentEl != map.contentEl
        );
        const markersToUpdate = [
            marker,
            ...otherMaps.map((map) =>
                map.map.markers.find((m) => m.id == marker.id)
            )
        ];

        markerSettingsModal.onClose = async () => {
            if (markerSettingsModal.deleted) {
                map.removeMarker(marker);
                otherMaps.forEach((oM) => {
                    let otherMarker = oM.map.markers.find(
                        (m) => m.id == marker.id
                    );
                    oM.map.removeMarker(otherMarker);
                });
            } else {
                [map, ...otherMaps.map((m) => m.map)].forEach((map) => {
                    map.displaying.delete(marker.type);
                    map.displaying.set(
                        markerSettingsModal.tempMarker.type,
                        true
                    );
                });
                markersToUpdate.forEach((m) => {
                    m.link = markerSettingsModal.tempMarker.link;
                    m.icon = map.markerIcons.find(
                        (i) => i.type === markerSettingsModal.tempMarker.type
                    );

                    m.command = markerSettingsModal.tempMarker.command;
                });
                await this.saveSettings();
            }
        };

        markerSettingsModal.open();
    }
}
