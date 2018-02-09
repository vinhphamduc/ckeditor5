/**
 * @license Copyright (c) 2003-2018, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/**
 * @module engine/controller/editingcontroller
 */

import RootEditableElement from '../view/rooteditableelement';
import View from '../view/view';
import Mapper from '../conversion/mapper';
import ModelConversionDispatcher from '../conversion/modelconversiondispatcher';
import {
	insertText,
	remove
} from '../conversion/model-to-view-converters';
import { convertSelectionChange } from '../conversion/view-selection-to-model-converters';
import {
	convertRangeSelection,
	convertCollapsedSelection,
	clearAttributes,
	clearFakeSelection
} from '../conversion/model-selection-to-view-converters';

import ObservableMixin from '@ckeditor/ckeditor5-utils/src/observablemixin';
import mix from '@ckeditor/ckeditor5-utils/src/mix';

/**
 * Controller for the editing pipeline. The editing pipeline controls {@link ~EditingController#model model} rendering,
 * including selection handling. It also creates the {@link ~EditingController#view view document} which builds a
 * browser-independent virtualization over the DOM elements. The editing controller also attaches default converters.
 *
 * @mixes module:utils/observablemixin~ObservableMixin
 */
export default class EditingController {
	/**
	 * Creates an editing controller instance.
	 *
	 * @param {module:engine/model/model~Model} model Editing model.
	 */
	constructor( model ) {
		/**
		 * Editing model.
		 *
		 * @readonly
		 * @member {module:engine/model/model~Model}
		 */
		this.model = model;

		/**
		 * Editing view controller.
		 *
		 * @readonly
		 * @member {module:engine/view/view~View}
		 */
		this.view = new View();

		/**
		 * Mapper which describes the model-view binding.
		 *
		 * @readonly
		 * @member {module:engine/conversion/mapper~Mapper}
		 */
		this.mapper = new Mapper();

		/**
		 * Model-to-view conversion dispatcher that converts changes from the model to {@link #view the editing view}.
		 *
		 * To attach the model-to-view converter to the editing pipeline you need to add a listener to this dispatcher:
		 *
		 *		editing.modelToView( 'insert:$element', customInsertConverter );
		 *
		 * Or use {@link module:engine/conversion/buildmodelconverter~ModelConverterBuilder}:
		 *
		 *		buildModelConverter().for( editing.modelToView ).fromAttribute( 'bold' ).toElement( 'b' );
		 *
		 * @readonly
		 * @member {module:engine/conversion/modelconversiondispatcher~ModelConversionDispatcher} #modelToView
		 */
		this.modelToView = new ModelConversionDispatcher( this.model, {
			mapper: this.mapper
		} );

		const doc = this.model.document;

		this.listenTo( doc, 'change', () => {
			this.view.change( writer => {
				this.modelToView.convertChanges( doc.differ, writer );
				this.modelToView.convertSelection( doc.selection, writer );
			} );
		}, { priority: 'low' } );

		// Convert selection from view to model.
		this.listenTo( this.view.document, 'selectionChange', convertSelectionChange( this.model, this.mapper ) );

		// Attach default model converters.
		this.modelToView.on( 'insert:$text', insertText(), { priority: 'lowest' } );
		this.modelToView.on( 'remove', remove(), { priority: 'low' } );

		// Attach default model selection converters.
		this.modelToView.on( 'selection', clearAttributes(), { priority: 'low' } );
		this.modelToView.on( 'selection', clearFakeSelection(), { priority: 'low' } );
		this.modelToView.on( 'selection', convertRangeSelection(), { priority: 'low' } );
		this.modelToView.on( 'selection', convertCollapsedSelection(), { priority: 'low' } );

		// Convert markers removal.
		//
		// Markers should be removed from the view before changes to the model are applied. This is because otherwise
		// it would be impossible to map some markers to the view (if, for example, the marker's boundary parent got removed).
		//
		// `removedMarkers` keeps information which markers already has been removed to prevent removing them twice.
		const removedMarkers = new Set();

		this.listenTo( model, 'applyOperation', ( evt, args ) => {
			// Before operation is applied...
			const operation = args[ 0 ];

			for ( const marker of model.markers ) {
				// Check all markers, that aren't already removed...
				if ( removedMarkers.has( marker.name ) ) {
					continue;
				}

				const markerRange = marker.getRange();

				if ( _operationAffectsMarker( operation, marker ) ) {
					// And if the operation in any way modifies the marker, remove the marker from the view.
					removedMarkers.add( marker.name );
					this.view.change( writer => {
						this.modelToView.convertMarkerRemove( marker.name, markerRange, writer );
					} );

					// TODO: This stinks but this is the safest place to have this code.
					this.model.document.differ.bufferMarkerChange( marker.name, markerRange, markerRange );
				}
			}
		}, { priority: 'high' } );

		// If a marker is removed through `model.Model#markers` directly (not through operation), just remove it (if
		// it was not removed already).
		this.listenTo( model.markers, 'remove', ( evt, marker ) => {
			if ( !removedMarkers.has( marker.name ) ) {
				removedMarkers.add( marker.name );
				this.view.change( writer => {
					this.modelToView.convertMarkerRemove( marker.name, marker.getRange(), writer );
				} );
			}
		} );

		// When all changes are done, clear `removedMarkers` set.
		this.listenTo( model, '_change', () => {
			removedMarkers.clear();
		}, { priority: 'low' } );

		// Binds {@link module:engine/view/document~Document#roots view roots collection} to
		// {@link module:engine/model/document~Document#roots model roots collection} so creating
		// model root automatically creates corresponding view root.
		this.view.document.roots.bindTo( this.model.document.roots ).using( root => {
			// $graveyard is a special root that has no reflection in the view.
			if ( root.rootName == '$graveyard' ) {
				return null;
			}

			const viewRoot = new RootEditableElement( root.name );

			viewRoot.rootName = root.rootName;
			viewRoot.document = this.view.document;
			this.mapper.bindElements( root, viewRoot );

			return viewRoot;
		} );
	}

	/**
	 * Removes all event listeners attached to the `EditingController`. Destroys all objects created
	 * by `EditingController` that need to be destroyed.
	 */
	destroy() {
		this.view.destroy();
		this.stopListening();
	}
}

mix( EditingController, ObservableMixin );

// Helper function which checks whether given operation will affect given marker after the operation is applied.
function _operationAffectsMarker( operation, marker ) {
	const range = marker.getRange();

	if ( operation.type == 'insert' || operation.type == 'rename' ) {
		return _positionAffectsRange( operation.position, range );
	} else if ( operation.type == 'move' || operation.type == 'remove' || operation.type == 'reinsert' ) {
		return _positionAffectsRange( operation.targetPosition, range ) || _positionAffectsRange( operation.sourcePosition, range );
	} else if ( operation.type == 'marker' && operation.name == marker.name ) {
		return true;
	}

	return false;
}

// Helper function which checks whether change at given position affects given range.
function _positionAffectsRange( position, range ) {
	return range.containsPosition( position ) || !range.start._getTransformedByInsertion( position, 1, true ).isEqual( range.start );
}
