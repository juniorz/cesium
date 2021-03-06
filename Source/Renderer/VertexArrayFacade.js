/*global define*/
define([
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        './BufferUsage'
    ], function(
        ComponentDatatype,
        defaultValue,
        destroyObject,
        DeveloperError,
        BufferUsage) {
    "use strict";

    /**
     * DOC_TBA
     *
     * @alias VertexArrayFacade
     *
     * @constructor
     *
     * @exception {DeveloperError} context is required.
     * @exception {DeveloperError} At least one attribute is required.
     * @exception {DeveloperError} Attribute must have a componentsPerAttribute.
     * @exception {DeveloperError} Attribute must have a valid componentDatatype or not specify it.
     * @exception {DeveloperError} Attribute must have a valid usage or not specify it.
     * @exception {DeveloperError} Index n is used by more than one attribute.
     */
    var VertexArrayFacade = function(context, attributes, sizeInVertices) {
        if (!context) {
            throw new DeveloperError('context is required.');
        }

        if (!attributes || (attributes.length === 0)) {
            throw new DeveloperError('At least one attribute is required.');
        }

        var attrs = VertexArrayFacade._verifyAttributes(attributes);

        sizeInVertices = sizeInVertices || 0;

        var attributesByPurposeAndUsage = {};
        var precreatedAttributes = [];

        var attributesByUsage;
        var attributesForUsage;
        var purpose;
        var usage;

        // Bucket the attributes first by purpose and second by usage.
        var length = attrs.length;
        for (var i = 0; i < length; ++i) {
            var attribute = attrs[i];

            // If the attribute already has a vertex buffer, we do not need
            // to manage a vertex buffer or typed array for it.
            if (attribute.vertexBuffer) {
                precreatedAttributes.push(attribute);
                continue;
            }

            purpose = attribute.purpose;
            attributesByUsage = attributesByPurposeAndUsage[purpose];
            if (typeof attributesByUsage === 'undefined') {
                attributesByUsage = attributesByPurposeAndUsage[purpose] = {};
            }

            usage = attribute.usage.toString();
            attributesForUsage = attributesByUsage[usage];
            if (typeof attributesForUsage === 'undefined') {
                attributesForUsage = attributesByUsage[usage] = [];
            }

            attributesForUsage.push(attribute);
        }

        // A function to sort attributes by the size of their components.  From left to right, a vertex
        // stores floats, shorts, and then bytes.
        function compare(left, right) {
            return right.componentDatatype.sizeInBytes - left.componentDatatype.sizeInBytes;
        }

        // Create a buffer description for each purpose/usage combination.
        this._buffersByPurposeAndUsage = {};
        this._allBuffers = [];

        for (purpose in attributesByPurposeAndUsage) {
            if (attributesByPurposeAndUsage.hasOwnProperty(purpose)) {
                attributesByUsage = attributesByPurposeAndUsage[purpose];

                var buffersByUsage = this._buffersByPurposeAndUsage[purpose];
                if (typeof buffersByUsage === 'undefined') {
                    buffersByUsage = this._buffersByPurposeAndUsage[purpose] = {};
                }

                for (usage in attributesByUsage) {
                    if (attributesByUsage.hasOwnProperty(usage)) {
                        attributesForUsage = attributesByUsage[usage];

                        attributesForUsage.sort(compare);
                        var vertexSizeInBytes = VertexArrayFacade._vertexSizeInBytes(attributesForUsage);

                        var usageEnum;
                        switch (usage) {
                        case BufferUsage.STATIC_DRAW.toString():
                            usageEnum = BufferUsage.STATIC_DRAW;
                            break;
                        case BufferUsage.STREAM_DRAW.toString():
                            usageEnum = BufferUsage.STREAM_DRAW;
                            break;
                        case BufferUsage.DYNAMIC_DRAW.toString():
                            usageEnum = BufferUsage.DYNAMIC_DRAW;
                            break;
                        }

                        var buffer = {
                            purpose : purpose,

                            vertexSizeInBytes : vertexSizeInBytes,

                            vertexBuffer : undefined,
                            usage : usageEnum,
                            needsCommit : false,

                            arrayBuffer : undefined,
                            arrayViews : VertexArrayFacade._createArrayViews(attributesForUsage, vertexSizeInBytes)
                        };

                        buffersByUsage[usage] = buffer;
                        this._allBuffers.push(buffer);
                    }
                }
            }
        }

        this._size = 0;

        this._precreated = precreatedAttributes;
        this._context = context;

        /**
         * DOC_TBA
         */
        this.writers = undefined;

        /**
         * DOC_TBA
         */
        this.vaByPurpose = undefined;

        this.resize(sizeInVertices);
    };

    VertexArrayFacade._verifyAttributes = function(attributes) {
        var attrs = [];

        for ( var i = 0; i < attributes.length; ++i) {
            var attribute = attributes[i];

            var attr = {
                index : defaultValue(attribute.index, i),
                enabled : defaultValue(attribute.enabled, true),
                componentsPerAttribute : attribute.componentsPerAttribute,
                componentDatatype : attribute.componentDatatype || ComponentDatatype.FLOAT,
                normalize : attribute.normalize || false,
                purpose : defaultValue(attribute.purpose, 'all'),

                // There will be either a vertexBuffer or an [optional] usage.
                vertexBuffer : attribute.vertexBuffer,
                usage : attribute.usage || BufferUsage.STATIC_DRAW
            };
            attrs.push(attr);

            if ((attr.componentsPerAttribute !== 1) && (attr.componentsPerAttribute !== 2) && (attr.componentsPerAttribute !== 3) && (attr.componentsPerAttribute !== 4)) {
                throw new DeveloperError('attribute.componentsPerAttribute must be in the range [1, 4].');
            }

            var datatype = attr.componentDatatype;
            if (!ComponentDatatype.validate(datatype)) {
                throw new DeveloperError('Attribute must have a valid componentDatatype or not specify it.');
            }

            if (!BufferUsage.validate(attr.usage)) {
                throw new DeveloperError('Attribute must have a valid usage or not specify it.');
            }
        }

        // Verify all attribute names are unique.
        // Multiple attributes can share a name as long as they have different purposes.
        var uniqueIndices = new Array(attrs.length);
        for ( var j = 0; j < attrs.length; ++j) {
            var currentAttr = attrs[j];
            var index = currentAttr.index;
            var purpose = currentAttr.purpose;

            if (purpose !== 'all') {
                var uniqueIndex = uniqueIndices[index];
                if (uniqueIndex === true) {
                    throw new DeveloperError('Index ' + index + ' is used by more than one attribute.');
                }
                if (typeof uniqueIndex !== 'undefined') {
                    if (uniqueIndex[purpose]) {
                        throw new DeveloperError('Index ' + index + ' is used by more than one attribute with the same purpose.');
                    }
                } else {
                    uniqueIndex = uniqueIndices[index] = {};
                }
                uniqueIndex[purpose] = true;
            } else {
                if (uniqueIndices[index]) {
                    throw new DeveloperError('Index ' + index + ' is used by more than one attribute.');
                }
                uniqueIndices[index] = true;
            }
        }

        return attrs;
    };

    VertexArrayFacade._vertexSizeInBytes = function(attributes) {
        var sizeInBytes = 0;

        var length = attributes.length;
        for ( var i = 0; i < length; ++i) {
            var attribute = attributes[i];
            sizeInBytes += (attribute.componentsPerAttribute * attribute.componentDatatype.sizeInBytes);
        }

        var maxComponentSizeInBytes = (length > 0) ? attributes[0].componentDatatype.sizeInBytes : 0; // Sorted by size
        var remainder = (maxComponentSizeInBytes > 0) ? (sizeInBytes % maxComponentSizeInBytes) : 0;
        var padding = (remainder === 0) ? 0 : (maxComponentSizeInBytes - remainder);
        sizeInBytes += padding;

        return sizeInBytes;
    };

    VertexArrayFacade._createArrayViews = function(attributes, vertexSizeInBytes) {
        var views = [];
        var offsetInBytes = 0;

        var length = attributes.length;
        for ( var i = 0; i < length; ++i) {
            var attribute = attributes[i];
            var componentDatatype = attribute.componentDatatype;

            views.push({
                index : attribute.index,
                enabled : attribute.enabled,
                componentsPerAttribute : attribute.componentsPerAttribute,
                componentDatatype : componentDatatype,
                normalize : attribute.normalize,

                offsetInBytes : offsetInBytes,
                vertexSizeInComponentType : vertexSizeInBytes / componentDatatype.sizeInBytes,

                view : undefined
            });

            offsetInBytes += (attribute.componentsPerAttribute * componentDatatype.sizeInBytes);
        }

        return views;
    };

    /**
     * DOC_TBA
     *
     * Invalidates writers.  Can't render again until commit is called.
     *
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.resize = function(sizeInVertices) {
        this._size = sizeInVertices;

        var allBuffers = this._allBuffers;
        this.writers = {};

        for (var i = 0, len = allBuffers.length; i < len; ++i) {
            var buffer = allBuffers[i];
            VertexArrayFacade._resize(buffer, this._size);

            var writersForPurpose = this.writers[buffer.purpose];
            if (typeof writersForPurpose === 'undefined') {
                writersForPurpose = this.writers[buffer.purpose] = [];
            }

            // Reserving invalidates the writers, so if client's cache them, they need to invalidate their cache.
            VertexArrayFacade._appendWriters(writersForPurpose, buffer);
        }

        // VAs are recreated next time commit is called.
        destroyVA(this);
    };

    VertexArrayFacade._resize = function(buffer, size) {
        if (buffer.vertexSizeInBytes > 0) {
            // Create larger array buffer
            var arrayBuffer = new ArrayBuffer(size * buffer.vertexSizeInBytes);

            // Copy contents from previous array buffer
            if (buffer.arrayBuffer) {
                var destView = new Uint8Array(arrayBuffer);
                var sourceView = new Uint8Array(buffer.arrayBuffer);
                var sourceLength = sourceView.length;
                for ( var j = 0; j < sourceLength; ++j) {
                    destView[j] = sourceView[j];
                }
            }

            // Create typed views into the new array buffer
            var views = buffer.arrayViews;
            var length = views.length;
            for ( var i = 0; i < length; ++i) {
                var view = views[i];
                view.view = view.componentDatatype.createArrayBufferView(arrayBuffer, view.offsetInBytes);
            }

            buffer.arrayBuffer = arrayBuffer;
        }
    };

    var createWriters = [
    // 1 component per attribute
    function(buffer, view, vertexSizeInComponentType) {
        return function(index, attribute) {
            view[index * vertexSizeInComponentType] = attribute;
            buffer.needsCommit = true;
        };
    },

    // 2 component per attribute
    function(buffer, view, vertexSizeInComponentType) {
        return function(index, component0, component1) {
            var i = index * vertexSizeInComponentType;
            view[i] = component0;
            view[i + 1] = component1;
            buffer.needsCommit = true;
        };
    },

    // 3 component per attribute
    function(buffer, view, vertexSizeInComponentType) {
        return function(index, component0, component1, component2) {
            var i = index * vertexSizeInComponentType;
            view[i] = component0;
            view[i + 1] = component1;
            view[i + 2] = component2;
            buffer.needsCommit = true;
        };
    },

    // 4 component per attribute
    function(buffer, view, vertexSizeInComponentType) {
        return function(index, component0, component1, component2, component3) {
            var i = index * vertexSizeInComponentType;
            view[i] = component0;
            view[i + 1] = component1;
            view[i + 2] = component2;
            view[i + 3] = component3;
            buffer.needsCommit = true;
        };
    }];

    VertexArrayFacade._appendWriters = function(writers, buffer) {
        var arrayViews = buffer.arrayViews;
        var length = arrayViews.length;
        for ( var i = 0; i < length; ++i) {
            var arrayView = arrayViews[i];
            writers[arrayView.index] = createWriters[arrayView.componentsPerAttribute - 1](buffer, arrayView.view, arrayView.vertexSizeInComponentType);
        }
    };

    // Using unsigned short indices, 64K vertices can be indexed by one index buffer
    var sixtyFourK = 64 * 1024;

    /**
     * DOC_TBA
     *
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.commit = function(indexBuffer) {
        var recreateVA = false;

        var allBuffers = this._allBuffers;
        var buffer;

        for (var i = 0, len = allBuffers.length; i < len; ++i) {
            buffer = allBuffers[i];
            recreateVA = commit(this, buffer) || recreateVA;
        }

        ///////////////////////////////////////////////////////////////////////

        if (recreateVA || typeof this.vaByPurpose === 'undefined') {
            var buffersByPurposeAndUsage = this._buffersByPurposeAndUsage;

            destroyVA(this);
            this.vaByPurpose = {};

            for (var purpose in buffersByPurposeAndUsage) {
                if (buffersByPurposeAndUsage.hasOwnProperty(purpose)) {
                    var buffersByUsage = buffersByPurposeAndUsage[purpose];

                    var va = [];
                    var numberOfVertexArrays = Math.ceil(this._size / sixtyFourK);
                    for ( var k = 0; k < numberOfVertexArrays; ++k) {
                        var attributes = [];

                        // Add all-purpose attributes
                        var allPurposeBuffersByUsage = buffersByPurposeAndUsage.all;
                        if (allPurposeBuffersByUsage !== buffersByUsage) {
                            for (var allPurposeUsage in allPurposeBuffersByUsage) {
                                if (allPurposeBuffersByUsage.hasOwnProperty(allPurposeUsage)) {
                                    var allPurposeBuffer = allPurposeBuffersByUsage[allPurposeUsage];
                                    VertexArrayFacade._appendAttributes(attributes, allPurposeBuffer, k * (allPurposeBuffer.vertexSizeInBytes * sixtyFourK));
                                }
                            }
                        }

                        // Add purpose-specific attributes
                        for (var usage in buffersByUsage) {
                            if (buffersByUsage.hasOwnProperty(usage)) {
                                buffer = buffersByUsage[usage];
                                VertexArrayFacade._appendAttributes(attributes, buffer, k * (buffer.vertexSizeInBytes * sixtyFourK));
                            }
                        }

                        attributes = attributes.concat(this._precreated);

                        va.push({
                            va : this._context.createVertexArray(attributes, indexBuffer),
                            indicesCount : 1.5 * ((k !== (numberOfVertexArrays - 1)) ? sixtyFourK : (this._size % sixtyFourK))
                        // TODO: not hardcode 1.5
                        });
                    }

                    this.vaByPurpose[purpose] = va;
                }
            }
        }
    };

    function commit(vertexArrayFacade, buffer) {
        if (buffer.needsCommit && (buffer.vertexSizeInBytes > 0)) {
            buffer.needsCommit = false;

            var vertexBuffer = buffer.vertexBuffer;
            var vertexBufferSizeInBytes = vertexArrayFacade._size * buffer.vertexSizeInBytes;
            var vertexBufferDefined = typeof vertexBuffer !== 'undefined';
            if (!vertexBufferDefined || (vertexBuffer.getSizeInBytes() < vertexBufferSizeInBytes)) {
                if (vertexBufferDefined) {
                    vertexBuffer.destroy();
                }
                buffer.vertexBuffer = vertexArrayFacade._context.createVertexBuffer(buffer.arrayBuffer, buffer.usage);
                buffer.vertexBuffer.setVertexArrayDestroyable(false);

                return true; // Created new vertex buffer
            }

            buffer.vertexBuffer.copyFromArrayView(buffer.arrayBuffer);
        }

        return false; // Did not create new vertex buffer
    }

    VertexArrayFacade._appendAttributes = function(attributes, buffer, vertexBufferOffset) {
        var arrayViews = buffer.arrayViews;
        var length = arrayViews.length;
        for ( var i = 0; i < length; ++i) {
            var view = arrayViews[i];

            attributes.push({
                index : view.index,
                enabled : view.enabled,
                componentsPerAttribute : view.componentsPerAttribute,
                componentDatatype : view.componentDatatype,
                normalize : view.normalize,
                vertexBuffer : buffer.vertexBuffer,
                offsetInBytes : vertexBufferOffset + view.offsetInBytes,
                strideInBytes : buffer.vertexSizeInBytes
            });
        }
    };

    /**
     * DOC_TBA
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.subCommit = function(offsetInVertices, lengthInVertices) {
        if (offsetInVertices < 0 || offsetInVertices >= this._size) {
            throw new DeveloperError('offsetInVertices must be greater than or equal to zero and less than the vertex array size.');
        }

        if (offsetInVertices + lengthInVertices > this._size) {
            throw new DeveloperError('offsetInVertices + lengthInVertices cannot exceed the vertex array size.');
        }

        var allBuffers = this._allBuffers;

        for (var i = 0, len = allBuffers.length; i < len; ++i) {
            subCommit(this, allBuffers[i], offsetInVertices, lengthInVertices);
        }
    };

    function subCommit(vertexArrayFacade, buffer, offsetInVertices, lengthInVertices) {
        if (buffer.needsCommit && (buffer.vertexSizeInBytes > 0)) {
            var byteOffset = buffer.vertexSizeInBytes * offsetInVertices;
            var byteLength = buffer.vertexSizeInBytes * lengthInVertices;

            // PERFORMANCE_IDEA: If we want to get really crazy, we could consider updating
            // individual attributes instead of the entire (sub-)vertex.
            //
            // PERFORMANCE_IDEA: Does creating the typed view add too much GC overhead?
            buffer.vertexBuffer.copyFromArrayView(new Uint8Array(buffer.arrayBuffer, byteOffset, byteLength), byteOffset);
        }
    }

    /**
     * DOC_TBA
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.endSubCommits = function() {
        var allBuffers = this._allBuffers;

        for (var i = 0, len = allBuffers.length; i < len; ++i) {
            allBuffers[i].needsCommit = false;
        }
    };

    function destroyVA(vertexArrayFacade) {
        var vaByPurpose = vertexArrayFacade.vaByPurpose;
        if (typeof vaByPurpose === 'undefined') {
            return;
        }

        for (var purpose in vaByPurpose) {
            if (vaByPurpose.hasOwnProperty(purpose)) {
                var va = vaByPurpose[purpose];
                var length = va.length;
                for (var i = 0; i < length; ++i) {
                    va[i].va.destroy();
                }
            }
        }

        vertexArrayFacade.vaByPurpose = undefined;
    }

    /**
     * DOC_TBA
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * DOC_TBA
     * @memberof VertexArrayFacade
     */
    VertexArrayFacade.prototype.destroy = function() {
        var allBuffers = this._allBuffers;
        for (var i = 0, len = allBuffers.length; i < len; ++i) {
            var buffer = allBuffers[i];
            buffer.vertexBuffer = buffer.vertexBuffer && buffer.vertexBuffer.destroy();
        }

        destroyVA(this);

        return destroyObject(this);
    };

    return VertexArrayFacade;
});