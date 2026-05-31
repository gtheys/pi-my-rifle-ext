# Common OWL Axiom Patterns

## Disjoint Classes (things that cannot both be true)

```turtle
[] a owl:AllDisjointClasses ;
    owl:members ( :Customer :Supplier :Employee ) .
```

## Subclass / Inheritance

```turtle
:PremiumCustomer rdfs:subClassOf :Customer ;
    rdfs:comment "A customer with a premium subscription." .
```

## Enumerated Values (ENUM columns)

```turtle
:OrderStatus a owl:Class ;
    owl:equivalentClass [
        a owl:Class ;
        owl:oneOf ( :Pending :Confirmed :Shipped :Delivered :Cancelled )
    ] .

:Pending   a :OrderStatus ; rdfs:label "Pending" .
:Confirmed a :OrderStatus ; rdfs:label "Confirmed" .
```

## Symmetric Property (mutual relationships)

```turtle
:isRelatedTo a owl:ObjectProperty, owl:SymmetricProperty ;
    rdfs:domain :Product ;
    rdfs:range  :Product .
```

## Transitive Property (hierarchies)

```turtle
:isPartOf a owl:ObjectProperty, owl:TransitiveProperty ;
    rdfs:domain :Component ;
    rdfs:range  :Component .
```

## Many-to-Many (junction table collapsed)

Instead of a class for `order_items`, create a property:

```turtle
:contains a owl:ObjectProperty ;
    rdfs:domain :Order ;
    rdfs:range  :Product ;
    rdfs:label  "contains" .

:isContainedIn owl:inverseOf :contains .
```

## Property with Cardinality

```turtle
# Exactly one billing address
:Order rdfs:subClassOf [
    a owl:Restriction ;
    owl:onProperty :hasBillingAddress ;
    owl:cardinality 1
] .

# At least one line item
:Order rdfs:subClassOf [
    a owl:Restriction ;
    owl:onProperty :contains ;
    owl:minCardinality 1
] .
```
