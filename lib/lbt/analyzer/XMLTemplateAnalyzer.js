"use strict";

/*
 * TODOS
 * - find better way to distinguish between aggregation tags and control tags
 *   (currently, existence in pool is used to recognize controls)
 * - support alternative namespace URLs for libraries (as used by XSD files)
 * - make set of view types configurable
 * - plugin mechanism to support other special controls
 * - move UI5 specific constants to UI5ClientConstants?
 */

const xml2js = require("xml2js");
const ModuleName = require("../utils/ModuleName");
const log = require("@ui5/logger").getLogger("XMLTemplateAnalyzer");

// ---------------------------------------------------------------------------------------------------------

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const TEMPLATING_NAMESPACE = "http://schemas.sap.com/sapui5/extension/sap.ui.core.template/1";
const TEMPLATING_CONDITONAL_TAGS = /^(?:if|repeat)$/;

const PATTERN_LIBRARY_NAMESPACES = /^([a-zA-Z_$][a-zA-z0-9_$]*(\.[a-zA-Z_$][a-zA-z0-9_$]*)*)$/;

// component container
const COMPONENTCONTAINER_MODULE = "sap/ui/core/ComponentContainer.js";
const COMPONENTCONTAINER_COMPONENTNAME_ATTRIBUTE = "name";

// fragment definition
const FRAGMENTDEFINITION_MODULE = "sap/ui/core/FragmentDefinition.js";

// fragment
const FRAGMENT_MODULE = "sap/ui/core/Fragment.js";
const FRAGMENT_FRAGMENTNAME_ATTRIBUTE = "fragmentName";
const FRAGMENT_TYPE_ATTRIBUTE = "type";

// different view types
const HTMLVIEW_MODULE = "sap/ui/core/mvc/HTMLView.js";
const JSVIEW_MODULE = "sap/ui/core/mvc/JSView.js";
const JSONVIEW_MODULE = "sap/ui/core/mvc/JSONView.js";
const XMLVIEW_MODULE = "sap/ui/core/mvc/XMLView.js";
const ANYVIEW_VIEWNAME_ATTRIBUTE = "viewName";
const XMLVIEW_CONTROLLERNAME_ATTRIBUTE = "controllerName";
const XMLVIEW_RESBUNDLENAME_ATTRIBUTE = "resourceBundleName";

/*
 * Helper to simplify access to node attributes.
 */
function getAttribute(node, attr) {
	return (node.$ && node.$[attr] && node.$[attr].value) || null;
}

/**
 * A dependency analyzer for XMLViews and XMLFragments.
 *
 * Parses the XML, collects controls and adds them as dependency to the ModuleInfo object.
 * Additionally, some special dependencies are handled:
 * <ul>
 * <li>controller of the view</li>
 * <li>resource bundle (note: locale dependent dependencies can't be modeled yet in ModuleInfo</li>
 * <li>component referenced via ComponentContainer control</li>
 * <li>embedded fragments or views</li>
 * </ul>
 *
 * In an XMLView, there usually exist 3 categories of element nodes: controls, aggregations
 * of cardinality 'multiple' and non-UI5 nodes (e.g. XHTML or SVG). The third category usually
 * can be identified by its namespace (whitelisted). To distinguish between the first and the second
 * category, this analyzer uses a ResourcePool (provided by the caller and usually derived from the
 * library classpath). When the qualified node name is contained in the pool, it is assumed to
 * represent a control, otherwise it is ignored.
 *
 * In certain cases this might give wrong results, but loading the metadata for each control
 * to implement the exactly same logic as used in the runtime XMLTemplateProcessor would be to
 * expensive and require too much runtime.
 *
 * @author Frank Weigel
 * @since 1.23.0
 * @private
 */
class XMLTemplateAnalyzer {
	constructor(pool) {
		this._pool = pool;
		this._parser = new xml2js.Parser({
			explicitRoot: false,
			explicitChildren: true,
			preserveChildrenOrder: true,
			xmlns: true
		});
		this.busy = false;
	}

	/**
	 * Add a dependency if it is new.
	 *
	 * @param {string} moduleName
	 */
	_addDependency(moduleName) {
		// don't add references to 'self'
		if ( this.info.name === moduleName ) {
			return;
		}

		this.info.addDependency(moduleName, this.conditional);
	}

	/**
	 * Enrich the given ModuleInfo for an XMLView.
	 *
	 * @param {string} xml xml string to be analyzed
	 * @param {ModuleInfo} info ModuleInfo to enrich
	 * @returns {Promise<ModuleInfo>} the created ModuleInfo
	 */
	analyzeView(xml, info) {
		return this._analyze(xml, info, false);
	}

	/**
	 * Enrich the given ModuleInfo for a fragment (XML).
	 *
	 * @param {string} xml xml string to be analyzed
	 * @param {ModuleInfo} info ModuleInfo to enrich
	 * @returns {Promise<ModuleInfo>} the created ModuleInfo
	 */
	analyzeFragment(xml, info) {
		return this._analyze(xml, info, true);
	}

	_analyze(xml, info, isFragment) {
		if ( this.busy ) {
			// TODO delegate to fresh instances instead
			throw new Error("analyzer is busy");
		}

		this.info = info;
		this.conditional = false;
		this.promises = [];
		this.busy = true;

		return new Promise( (resolve, reject) => {
			this._parser.parseString(xml, (err, result) => {
				// parse error
				if ( err ) {
					this.busy = false;
					reject(err);
					return;
				}

				// console.log(result);
				// clear();
				if ( isFragment ) {
					// all fragments implicitly depend on the fragment class
					this.info.addImplicitDependency(FRAGMENT_MODULE);
					this._analyzeNode(result);
				} else {
					// views require a special handling of the root node
					this._analyzeViewRootNode(result);
				}

				Promise.all(this.promises).then( () => {
					this.busy = false;
					resolve(info);
				});
				// console.log("Collected info for %s:", info.name, info);
			});
		});
	}

	_analyzeViewRootNode(node) {
		this.info.addImplicitDependency(XMLVIEW_MODULE);

		var controllerName = getAttribute(node, XMLVIEW_CONTROLLERNAME_ATTRIBUTE);
		if ( controllerName ) {
			this._addDependency( ModuleName.fromUI5LegacyName(controllerName, ".controller.js") );
		}

		var resourceBundleName = getAttribute(node, XMLVIEW_RESBUNDLENAME_ATTRIBUTE);
		if ( resourceBundleName ) {
			var resourceBundleModuleName = ModuleName.fromUI5LegacyName(resourceBundleName, ".properties");
			log.verbose("found dependency to resource bundle %s", resourceBundleModuleName);
			// TODO locale dependent dependencies: this._addDependency(resourceBundleModuleName);
			this._addDependency( resourceBundleModuleName );
		}

		this._analyzeChildren(node);
	}

	_analyzeNode(node) {
		var namespace = node.$ns.uri || "";
		var localName = node.$ns.local;

		var oldConditional = this.conditional;

		if ( namespace === TEMPLATING_NAMESPACE ) {
			if ( TEMPLATING_CONDITONAL_TAGS.test(localName) ) {
				this.conditional = true;
			}
		} else if ( namespace === XHTML_NAMESPACE || namespace === SVG_NAMESPACE ) {

			// ignore XHTML and SVG nodes

		} else if ( PATTERN_LIBRARY_NAMESPACES.test(namespace) ) {
			// looks like a UI5 library or package name
			var moduleName = ModuleName.fromUI5LegacyName( (namespace ? namespace + "." : "") + localName );

			// ignore FragmentDefinition (also skipped by runtime XMLTemplateProcessor)
			if ( FRAGMENTDEFINITION_MODULE !== moduleName ) {
				this.promises.push(

					this._pool.findResource(moduleName).then( () => {
						this._addDependency(moduleName);

						// handle special controls that reference other entities via name
						// - (HTML|JS|JSON|XML)View reference another view by 'viewName'
						// - ComponentContainer reference another component by 'componentName'
						// - Fragment references a fragment by 'fragmentName' . 'type'

						if ( moduleName === COMPONENTCONTAINER_MODULE ) {
							var componentName = getAttribute(node, COMPONENTCONTAINER_COMPONENTNAME_ATTRIBUTE);
							if ( componentName ) {
								var componentModuleName =
									ModuleName.fromUI5LegacyName( componentName, "/Component.js" );
								this._addDependency(componentModuleName);
							}
							// TODO what about component.json? handle it transitively via Component.js?
						} else if ( moduleName === FRAGMENT_MODULE ) {
							var fragmentName = getAttribute(node, FRAGMENT_FRAGMENTNAME_ATTRIBUTE);
							var type = getAttribute(node, FRAGMENT_TYPE_ATTRIBUTE);
							if ( fragmentName && type ) {
								var fragmentModuleName =
									ModuleName.fromUI5LegacyName( fragmentName, this._getFragmentExtension(type) );
								// console.log("child fragment detected %s", fragmentModuleName);
								this._addDependency(fragmentModuleName);
							}
						} else if ( moduleName === HTMLVIEW_MODULE ) {
							let viewName = getAttribute(node, ANYVIEW_VIEWNAME_ATTRIBUTE);
							if ( viewName ) {
								let childViewModuleName = ModuleName.fromUI5LegacyName( viewName, ".view.html" );
								// console.log("child view detected %s", childViewModuleName);
								this._addDependency(childViewModuleName);
							}
						} else if ( moduleName === JSVIEW_MODULE ) {
							let viewName = getAttribute(node, ANYVIEW_VIEWNAME_ATTRIBUTE);
							if ( viewName ) {
								let childViewModuleName = ModuleName.fromUI5LegacyName( viewName, ".view.js" );
								// console.log("child view detected %s", childViewModuleName);
								this._addDependency(childViewModuleName);
							}
						} else if ( moduleName === JSONVIEW_MODULE ) {
							let viewName = getAttribute(node, ANYVIEW_VIEWNAME_ATTRIBUTE);
							if ( viewName ) {
								let childViewModuleName = ModuleName.fromUI5LegacyName( viewName, ".view.json" );
								// console.log("child view detected %s", childViewModuleName);
								this._addDependency(childViewModuleName);
							}
						} else if ( moduleName === XMLVIEW_MODULE ) {
							let viewName = getAttribute(node, ANYVIEW_VIEWNAME_ATTRIBUTE);
							if ( viewName ) {
								let childViewModuleName = ModuleName.fromUI5LegacyName( viewName, ".view.xml" );
								// console.log("child view detected %s", childViewModuleName);
								this._addDependency(childViewModuleName);
							}
						}
					}, (err) => {
						// ignore missing resources
						// console.warn( "node not found %s", moduleName);
					})

				);
			}
		}

		this._analyzeChildren(node);

		// restore conditional state of the outer block
		this.conditional = oldConditional;
	}

	_analyzeChildren(node) {
		if ( Array.isArray(node.$$) ) {
			node.$$.forEach( (child) => this._analyzeNode( child ) );
		}
	}

	_getFragmentExtension(type) {
		return ".fragment." + type.toLowerCase();
	}
}


module.exports = XMLTemplateAnalyzer;